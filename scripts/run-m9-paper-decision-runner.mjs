#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixturePath = path.join(repoRoot, "tests", "fixtures", "m9", "paper-decision-runner.json");
const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-m9-paper");
const runtimeCounters = {
  unhandledRejections: 0,
  uncaughtExceptions: 0,
};

process.on("unhandledRejection", (reason) => {
  runtimeCounters.unhandledRejections += 1;
  process.stderr.write(`M9 paper decision runner unhandled rejection: ${toErrorMessage(reason)}\n`);
});

process.on("uncaughtException", (error) => {
  runtimeCounters.uncaughtExceptions += 1;
  process.stderr.write(`M9 paper decision runner uncaught exception: ${toErrorMessage(error)}\n`);
  process.exitCode = 1;
});

await main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!options.fixtureSmoke) {
    throw new Error("M9 paper decision runner는 현재 --fixture-smoke 경로만 제공한다.");
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const artifactDir = path.resolve(options.artifactDir ?? process.env.SEEMIRAI_M9_ARTIFACT_DIR ?? defaultArtifactDir);
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId, options });
  const git = await readGitContext();
  const fixture = await readJsonFile(options.fixturePath);
  const runtime = await importCompiledRuntime();
  const result = await runtime.runM9PaperDecisionFixtureSmoke({
    fixture,
    maxFrames: options.maxFrames,
  });

  const checks = createChecks(result, options);
  const summary = {
    schemaVersion: 1,
    runId,
    status: deriveStatus(checks),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMsRequested: 0,
    durationMsObserved: 0,
    mode: "PAPER_TRADING",
    input: "m9_paper_decision_fixture_smoke",
    git,
    artifacts,
    metrics: result.metrics,
    checks,
  };
  summary.durationMsObserved = new Date(summary.finishedAt).getTime() - startedAt.getTime();

  await writeArtifacts({ summary, result, artifacts });
  printSummary(summary, options);

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    fixturePath: defaultFixturePath,
    fixtureSmoke: false,
    json: false,
    help: false,
    dailyReportGenerated: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--fixture":
        options.fixturePath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--max-frames":
        options.maxFrames = readPositiveInteger(readValue(argv, index, arg), arg);
        index += 1;
        break;
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--summary-path":
        options.summaryPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--raw-log-path":
        options.rawLogPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--report-path":
        options.reportPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--daily-report-generated":
        options.dailyReportGenerated = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function readPositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

async function importCompiledRuntime() {
  const compileDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-m9-paper-decision-"));
  const tscArgs = [
    "-p",
    path.join(repoRoot, "tsconfig.m9-runner.json"),
    "--outDir",
    compileDir,
    "--noEmit",
    "false",
  ];
  const localTsc = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

  try {
    await stat(localTsc);
    await execFileAsync(localTsc, tscArgs, { cwd: repoRoot });
  } catch (error) {
    if (await fileExists(localTsc)) {
      throw error;
    }
    await execFileAsync("corepack", ["pnpm", "exec", "tsc", ...tscArgs], { cwd: repoRoot });
  }

  await symlink(path.join(repoRoot, "node_modules"), path.join(compileDir, "node_modules"), "dir");
  const runtimePath = path.join(compileDir, "src", "runtime", "paper-decision-runner.js");
  return import(pathToFileURL(runtimePath).href);
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function createChecks(result, options) {
  const hasSubmissionAndFill =
    result.metrics.paperOrderSubmittedCount > 0 && result.metrics.paperFillCount > 0;
  const zeroOrderFrameExplanation = summarizeZeroOrderFrames(result);
  const liveOrderApiCalls = result.metrics.liveOrderApiCalls;
  const traceMissingCount = result.trace.length > 0 ? 0 : 1;

  return {
    fixtureControlledPaperPath: hasSubmissionAndFill
      ? okCheck("controlled fixture에서 paper 주문 제출과 체결 경로를 확인했다.", {
          paperOrderSubmittedCount: result.metrics.paperOrderSubmittedCount,
          paperFillCount: result.metrics.paperFillCount,
        })
      : failCheck("controlled fixture에서 paper 주문 제출과 체결 경로를 확인하지 못했다.", {
          paperOrderSubmittedCount: result.metrics.paperOrderSubmittedCount,
        paperFillCount: result.metrics.paperFillCount,
      }),
    zeroOrderReasonsExplained: zeroOrderFrameExplanation.unexplainedFrameIds.length === 0
      ? okCheck("주문이 0건인 frame도 hold/discard/cost/risk reason count로 설명 가능하다.", {
          zeroOrderFrameCount: zeroOrderFrameExplanation.zeroOrderFrameCount,
          explainedZeroOrderFrameCount: zeroOrderFrameExplanation.explainedZeroOrderFrameCount,
          reasonCounts: zeroOrderFrameExplanation.reasonCounts,
          holdReasonCounts: result.metrics.holdReasonCounts,
          discardReasonCounts: result.metrics.discardReasonCounts,
          costRejectedCount: result.metrics.costRejectedCount,
          riskRejectedCount: result.metrics.riskRejectedCount,
        })
      : failCheck("주문이 0건인 frame 중 hold/discard/cost/risk reason trace가 없는 frame이 있다.", {
          zeroOrderFrameCount: zeroOrderFrameExplanation.zeroOrderFrameCount,
          unexplainedFrameIds: zeroOrderFrameExplanation.unexplainedFrameIds,
          reasonCounts: zeroOrderFrameExplanation.reasonCounts,
        }),
    liveOrderApiCalls:
      liveOrderApiCalls === 0
        ? okCheck("M9 decision runner는 PaperBroker만 사용해 live order API 호출이 없다.", {
            count: liveOrderApiCalls,
          })
        : failCheck("M9 decision runner에서 live order API 호출 metric이 0이 아니다.", {
            count: liveOrderApiCalls,
          }),
    auditMissing:
      traceMissingCount === 0
        ? okCheck("fixture decision trace가 각 차단/실행 단계를 남겼다.", {
            count: 0,
            traceRecords: result.trace.length,
          })
        : failCheck("fixture decision trace가 비어 있어 차단/실행 감사 근거를 확인할 수 없다.", {
            count: traceMissingCount,
            traceRecords: result.trace.length,
          }),
    notificationFailures: okCheck("decision runner smoke는 Telegram provider를 호출하지 않는다.", {
      count: 0,
    }),
    dailyReportGenerated: options.dailyReportGenerated
      ? okCheck("운영자가 이 summary를 daily report artifact와 연결했다.", {
          generated: true,
        })
      : skippedCheck("fixture smoke는 daily report job을 생성하지 않는다.", {
          generated: false,
          hint: "--daily-report-generated",
        }),
    runtimeExceptions: runtimeExceptionCheck(),
  };
}

async function writeArtifacts({ summary, result, artifacts }) {
  await mkdir(path.dirname(artifacts.summaryPath), { recursive: true });
  await mkdir(path.dirname(artifacts.reportPath), { recursive: true });
  await mkdir(path.dirname(artifacts.rawLogPath), { recursive: true });
  await writeFile(artifacts.reportPath, renderMarkdownReport(summary), "utf8");
  await writeTraceLog(artifacts.rawLogPath, result.trace);
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function writeTraceLog(filePath, trace) {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  for (const record of trace) {
    if (!stream.write(`${JSON.stringify(record)}\n`)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }
  await new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function summarizeZeroOrderFrames(result) {
  const frames = new Map();
  for (const record of result.trace) {
    const summary = readOrCreateFrameSummary(frames, record.frameId);
    if (record.stage === "EXECUTION_RESULT" && record.status === "SUBMITTED") {
      summary.submitted = true;
    }
    const reason = readZeroOrderReason(record);
    if (reason !== null) {
      summary.reasons.push(reason);
    }
  }

  const zeroOrderFrames = [...frames.entries()].filter(([, frame]) => !frame.submitted);
  const unexplainedFrameIds = zeroOrderFrames
    .filter(([, frame]) => frame.reasons.length === 0)
    .map(([frameId]) => frameId);
  const reasonCounts = {};
  for (const [, frame] of zeroOrderFrames) {
    for (const reason of frame.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }

  return {
    zeroOrderFrameCount: zeroOrderFrames.length,
    explainedZeroOrderFrameCount: zeroOrderFrames.length - unexplainedFrameIds.length,
    unexplainedFrameIds,
    reasonCounts,
  };
}

function readOrCreateFrameSummary(frames, frameId) {
  const existing = frames.get(frameId);
  if (existing !== undefined) {
    return existing;
  }

  const created = {
    submitted: false,
    reasons: [],
  };
  frames.set(frameId, created);
  return created;
}

function readZeroOrderReason(record) {
  if (record.stage === "STRATEGY_DECISION" && (record.status === "HOLD" || record.status === "BLOCK")) {
    return `${record.status.toLowerCase()}:${record.reasonCode ?? record.message ?? "unknown"}`;
  }
  if (record.stage === "ORDER_INTENT_CONVERSION" && record.status === "REJECTED") {
    return `discard:${record.reasonCode ?? "order_intent_conversion_rejected"}`;
  }
  if (record.stage === "COST_DECISION" && record.status === "REJECT") {
    return `cost:${record.reasonCode ?? "cost_rejected"}`;
  }
  if (record.stage === "RISK_DECISION" && record.status === "FAIL") {
    return `risk:${readFirstString(record.metadata?.failed_reason_codes) ?? record.reasonCode ?? "risk_rejected"}`;
  }
  if (record.stage === "EXECUTION_RESULT" && record.status === "REJECTED") {
    return `discard:${record.reasonCode ?? "execution_rejected"}`;
  }

  return null;
}

function readFirstString(value) {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function renderMarkdownReport(summary) {
  const metricRows = [
    ["strategyEvaluationCount", summary.metrics.strategyEvaluationCount],
    ["orderCandidateCount", summary.metrics.orderCandidateCount],
    ["orderIntentCount", summary.metrics.orderIntentCount],
    ["costRejectedCount", summary.metrics.costRejectedCount],
    ["riskRejectedCount", summary.metrics.riskRejectedCount],
    ["paperOrderSubmittedCount", summary.metrics.paperOrderSubmittedCount],
    ["paperFillCount", summary.metrics.paperFillCount],
    ["fillRate", summary.metrics.fillRate],
    ["liveOrderApiCalls", summary.metrics.liveOrderApiCalls],
  ]
    .map(([name, value]) => `| ${name} | ${escapeMarkdownTable(value)} |`)
    .join("\n");
  const checkRows = Object.entries(summary.checks)
    .map(([name, check]) => `| ${name} | ${check.status} | ${escapeMarkdownTable(check.message)} |`)
    .join("\n");

  return `# M9 Paper Decision Runner 결과

- 실행 상태: ${summary.status}
- 실행 모드: ${summary.mode}
- 입력: ${summary.input}
- 시작: ${summary.startedAt}
- 종료: ${summary.finishedAt}
- Git branch: ${summary.git.branch ?? "unknown"}
- Git commit: ${summary.git.commit ?? "unknown"}
- raw trace log: ${summary.artifacts.rawLogPath}

## 핵심 metric

| 항목 | 값 |
| --- | --- |
${metricRows}

## 차단/대기 사유

- holdReasonCounts: ${JSON.stringify(summary.metrics.holdReasonCounts)}
- discardReasonCounts: ${JSON.stringify(summary.metrics.discardReasonCounts)}
- blockingReasonCounts: ${JSON.stringify(summary.metrics.blockingReasonCounts)}

## 비용과 슬리피지

- costSummary: ${JSON.stringify(summary.metrics.costSummary)}
- slippageSummary: ${JSON.stringify(summary.metrics.slippageSummary)}

## 체크 결과

| 항목 | 결과 | 요약 |
| --- | --- | --- |
${checkRows}
`;
}

function createArtifactPaths({ artifactDir, startedAt, runId, options }) {
  const timestamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const prefix = `m9-paper-decision-${timestamp}-${runId.slice(0, 8)}`;
  return {
    rawLogPath: options.rawLogPath ?? path.join(artifactDir, `${prefix}-trace.jsonl`),
    summaryPath: options.summaryPath ?? path.join(artifactDir, `${prefix}-summary.json`),
    reportPath: options.reportPath ?? path.join(artifactDir, `${prefix}-report.md`),
  };
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  process.stdout.write(`M9 Paper Decision Runner 결과: ${summary.status}\n`);
  process.stdout.write(`- 요약 JSON: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`- 리포트: ${summary.artifacts.reportPath}\n`);
  process.stdout.write(`- paper 주문 제출: ${summary.metrics.paperOrderSubmittedCount}\n`);
  process.stdout.write(`- paper 체결: ${summary.metrics.paperFillCount}\n`);
}

function deriveStatus(checks) {
  return Object.values(checks).some((check) => check.status === "fail") ? "failed" : "passed";
}

function runtimeExceptionCheck() {
  const crashCount = runtimeCounters.uncaughtExceptions;
  const unhandledRejectionCount = runtimeCounters.unhandledRejections;
  if (crashCount > 0 || unhandledRejectionCount > 0) {
    return failCheck("runner 실행 중 처리되지 않은 예외가 관측됐다.", {
      crashCount,
      unhandledRejectionCount,
    });
  }

  return okCheck("crash와 unhandled rejection이 관측되지 않았다.", {
    crashCount: 0,
    unhandledRejectionCount: 0,
  });
}

function okCheck(message, evidence = {}) {
  return {
    status: "ok",
    message,
    evidence,
  };
}

function skippedCheck(message, evidence = {}) {
  return {
    status: "skipped",
    message,
    evidence,
  };
}

function failCheck(message, evidence = {}) {
  return {
    status: "fail",
    message,
    evidence,
  };
}

function escapeMarkdownTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, " ");
}

async function readGitContext() {
  const [branch, commit] = await Promise.all([
    readGitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    readGitValue(["rev-parse", "--short=12", "HEAD"]),
  ]);
  return { branch, commit };
}

async function readGitValue(args) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printHelp() {
  process.stdout.write(`사용법: node scripts/run-m9-paper-decision-runner.mjs --fixture-smoke [options]

옵션:
  --fixture-smoke             deterministic M9 paper decision fixture smoke를 실행한다.
  --fixture <path>            fixture 경로. 기본값은 tests/fixtures/m9/paper-decision-runner.json.
  --max-frames <count>        최대 처리 frame 수.
  --artifact-dir <path>       artifact 디렉터리. 기본값은 SEEMIRAI_M9_ARTIFACT_DIR 또는 ~/vaults/99_운영/seemirai-m9-paper.
  --summary-path <path>       summary JSON 출력 경로.
  --raw-log-path <path>       JSONL trace 출력 경로.
  --report-path <path>        Markdown report 출력 경로.
  --daily-report-generated    이 summary가 생성된 daily report artifact와 연결됐음을 표시한다.
  --json                      JSON summary를 stdout으로 출력한다.
  --help, -h                  도움말을 출력한다.
`);
}
