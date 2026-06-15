#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultArtifactDir = path.join(os.homedir(), "vaults", "99_운영", "seemirai-live-ops-real-arm-closeout");
const runGuardEnv = "SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT";
const expectedIssue = 206;
const expectedMode = "LIVE_AUTONOMOUS_SMALL_BUDGET";
const expectedMarket = "KRW-BTC";
const expectedSide = "BUY";
const expectedOrderType = "LIMIT";
const expectedTimeInForce = "POST_ONLY";
const minRequestedNotionalKrw = 5_000;
const maxRequestedNotionalKrw = 10_000;
const repositoryRoot = process.cwd();
const requiredKeyScopes = ["자산조회", "주문조회", "주문하기"];
const withdrawalScopeMarkers = ["출금", "withdraw"];
const forbiddenKeyScopeMarkers = ["출금", "입금", "withdraw", "deposit", "futures", "leverage", "margin"];
const requiredCounterNames = [
  "crashCount",
  "unhandledRejectionCount",
  "duplicateOrderCount",
  "reconcileMismatchCount",
  "untrackedFillCount",
  "liveOrderCleanupFailureCount",
];
const sensitivePatterns = [
  { label: "access_key json field", pattern: /"(?:seemirai_)?(?:upbit_)?access_key"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "accessKey json field", pattern: /"(?:upbit)?accessKey"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "secret_key json field", pattern: /"(?:seemirai_)?(?:upbit_)?secret_key"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "secretKey json field", pattern: /"(?:upbit)?secretKey"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "telegram token json field", pattern: /"telegram_bot_token"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "telegram botToken json field", pattern: /"(?:telegram)?botToken"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "telegram bot token url", pattern: /https:\/\/api\.telegram\.org\/bot(?!<redacted>|redacted|\[redacted\])[^/\s"']{8,}\/[A-Za-z]+/i },
  { label: "access key env assignment", pattern: /\b(?:SEEMIRAI_)?(?:UPBIT_)?ACCESS_KEY\s*=\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:\s|$|["',]))\S{8,}/i },
  { label: "secret key env assignment", pattern: /\b(?:SEEMIRAI_)?(?:UPBIT_)?SECRET_KEY\s*=\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:\s|$|["',]))\S{8,}/i },
  { label: "telegram token env assignment", pattern: /\b(?:SEEMIRAI_)?TELEGRAM_BOT_TOKEN\s*=\s*(?!(?:["']?(?:<redacted>|redacted|\[redacted\])["']?)(?:\s|$|["',]))\S{8,}/i },
  { label: "raw authorization bearer", pattern: /authorization:\s*bearer\s+(?!<redacted>|redacted|\[redacted\])[^\s"']+/i },
  { label: "authorization json field", pattern: /"authorization"\s*:\s*"(?!bearer\s+(?:<redacted>|redacted|\[redacted\])"|(?:<redacted>|redacted|\[redacted\])")[^"]{8,}"/i },
  { label: "jwt json field", pattern: /"jwt"\s*:\s*"(?!<redacted>|redacted|\[redacted\])[^"]{8,}"/i },
  { label: "postgres credential url", pattern: /postgres(?:ql)?:\/\/[^:\s"']+:(?!(?:<redacted>|redacted|\[redacted\])@)[^@\s"']+@/i },
  { label: "raw provider field", pattern: /"raw(?:_|-)?provider(?:payload|body)?"\s*:/i },
  { label: "raw order field", pattern: /"raw(?:_|-)?order(?:detail|payload)?"\s*:/i },
  { label: "raw update field", pattern: /"raw(?:_|-)?update"\s*:/i },
];

try {
  await main();
} catch (error) {
  const options = parseArgsForFailure(process.argv.slice(2));
  const summary = await writeFailureSummary(error, options);
  printSummary(summary, options);
  process.exitCode = 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const startedAt = new Date();
  const runId = randomUUID();
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR ?? defaultArtifactDir));
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  await mkdir(artifactDir, { recursive: true });

  if (options.fixtureSmoke) {
    const fixture = await writeFixtureManifest(artifactDir);
    const summary = await buildAndWriteSummary({
      runId,
      startedAt,
      inputMode: "fixture_smoke",
      manifestPath: fixture.manifestPath,
      artifacts,
      guarded: false,
    });
    printSummary(summary, options);
    if (summary.status === "failed") {
      process.exitCode = 1;
    }
    return;
  }

  if (process.env[runGuardEnv] !== "1") {
    const summary = createSummary({
      runId,
      startedAt,
      inputMode: "guard_skipped",
      artifacts,
      metrics: createEmptyMetrics(),
      checks: {
        runGuard: skippedCheck("Issue #206 live:ops 실거래 closeout guard가 꺼져 있어 주문 artifact 검증을 실행하지 않았다.", {
          requiredEnv: `${runGuardEnv}=1`,
        }),
        operatorInputs: skippedCheck("저장소 밖 운영 config/env/evidence 경로가 확인되지 않아 실제 submit/cancel cleanup을 시작하지 않았다.", {
          requiredInputs: ["--manifest", "operator arm evidence", "config path", "env file path", "redacted artifact path"],
        }),
      },
    });
    await writeArtifacts(summary, artifacts);
    printSummary(summary, options);
    return;
  }

  const summary = await buildAndWriteSummary({
    runId,
    startedAt,
    inputMode: "real_arm_closeout_manifest",
    manifestPath: options.manifestPath,
    artifacts,
    guarded: true,
  });
  printSummary(summary, options);
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

async function buildAndWriteSummary(input) {
  const checks = {
    runGuard: input.guarded
      ? okCheck("명시 env guard가 확인되어 Issue #206 live:ops 실거래 closeout manifest 검증을 시작한다.", {
          requiredEnv: `${runGuardEnv}=1`,
        })
      : okCheck("fixture smoke는 live/API guard를 열지 않고 결정적 manifest만 검증한다.", { fixtureSmoke: true }),
  };

  if (!hasText(input.manifestPath)) {
    checks.manifestInput = failCheck("Issue #206 closeout manifest 경로가 필요하다.", { requiredArg: "--manifest" });
    const summary = createSummary({
      runId: input.runId,
      startedAt: input.startedAt,
      inputMode: input.inputMode,
      artifacts: input.artifacts,
      metrics: createEmptyMetrics(),
      checks,
    });
    await writeArtifacts(summary, input.artifacts);
    return summary;
  }

  const manifestFile = await readJsonFile(input.manifestPath, repositoryRoot);
  checks.manifestInput = manifestFile.error === undefined
    ? okCheck("Issue #206 closeout manifest를 파싱했다.", { manifestPath: manifestFile.filePath })
    : failCheck("Issue #206 closeout manifest를 파싱하지 못했다.", {
        manifestPath: manifestFile.filePath,
        error: manifestFile.error,
      });

  let metrics = createEmptyMetrics();
  if (manifestFile.error === undefined && isRecord(manifestFile.value)) {
    const validation = await validateManifest(manifestFile.value, manifestFile.filePath, manifestFile.rawText, {
      guarded: input.guarded,
    });
    Object.assign(checks, validation.checks);
    metrics = validation.metrics;
  } else if (manifestFile.error === undefined) {
    checks.manifestShape = failCheck("Issue #206 closeout manifest는 JSON object여야 한다.", {
      actualType: Array.isArray(manifestFile.value) ? "array" : typeof manifestFile.value,
    });
  }

  const summary = createSummary({
    runId: input.runId,
    startedAt: input.startedAt,
    inputMode: input.inputMode,
    artifacts: {
      ...input.artifacts,
      manifestPath: manifestFile.filePath,
    },
    metrics,
    checks,
  });
  await writeArtifacts(summary, input.artifacts);
  return summary;
}

async function validateManifest(manifest, manifestPath, manifestRawText, options) {
  const run = readRecord(manifest.run);
  const counters = readRecord(manifest.counters);
  const sourceScan = readRecord(manifest.sourceScan);
  const artifactPaths = readStringArray(manifest.artifactPaths);
  const artifactFiles = await readArtifactFiles(artifactPaths, path.dirname(manifestPath));
  const metrics = createMetrics(run, counters);
  return {
    metrics,
    checks: {
      manifestShape: createManifestShapeCheck(manifest),
      guardedArtifactInput: createGuardedArtifactInputCheck(manifest, manifestPath, artifactFiles, options.guarded),
      operatorInputs: await createOperatorInputsCheck(manifest, path.dirname(manifestPath), options.guarded),
      artifactFiles: createArtifactFilesCheck(artifactFiles),
      orderPolicy: createOrderPolicyCheck(run),
      orderLifecycle: createOrderLifecycleCheck(run),
      reconcileCloseout: createReconcileCloseoutCheck(manifest, run),
      closeoutZeroCounters: createZeroCounterCheck(counters),
      telegramTuiEvidence: createTelegramTuiEvidenceCheck(manifest),
      sourceSecurityScan: createSourceSecurityScanCheck(sourceScan, { guarded: options.guarded }),
      redactionScan: createRedactionScanCheck([
        { label: "manifest", rawText: manifestRawText },
        ...artifactFiles.map((file, index) => ({ label: `artifact-${index + 1}`, rawText: file.rawText })),
      ]),
      readinessAudit: createReadinessAuditCheck(manifest),
    },
  };
}

function createManifestShapeCheck(manifest) {
  const command = readString(manifest.command);
  const configPath = readString(manifest.configPath);
  const envFilePath = readString(manifest.envFilePath);
  const actual = {
    issue: manifest.issue,
    mode: manifest.mode,
    command,
    commandValid: isLiveOpsCommand(command, configPath, envFilePath),
  };
  if (manifest.issue === expectedIssue && manifest.mode === expectedMode && actual.commandValid) {
    return okCheck("Issue #206 closeout manifest가 issue/mode/command contract를 만족한다.", actual);
  }

  return failCheck("Issue #206 closeout manifest issue/mode/command contract가 맞지 않는다.", {
    expected: { issue: expectedIssue, mode: expectedMode, command: "corepack pnpm live:ops ..." },
    actual,
  });
}

function createGuardedArtifactInputCheck(manifest, manifestPath, artifactFiles, guarded) {
  if (!guarded) {
    return okCheck("fixture smoke는 guarded 운영 artifact 입력 검사를 열지 않는다.", { fixtureSmoke: true });
  }

  const fixtureMarkers = [
    manifest.fixture === true ? "manifest.fixture" : undefined,
    manifestPath.includes(".fixture") ? "manifest path" : undefined,
    ...artifactFiles
      .filter((file) => file.filePath.includes(".fixture") || /fixture/i.test(file.rawText))
      .map((file) => file.filePath),
  ].filter(hasText);

  if (fixtureMarkers.length === 0) {
    return okCheck("guarded closeout 입력이 fixture manifest/artifact를 사용하지 않는다.", { guarded: true });
  }

  return failCheck("guarded Issue #206 closeout에서는 fixture manifest/artifact를 사용할 수 없다.", { fixtureMarkers });
}

async function createOperatorInputsCheck(manifest, baseDir, guarded) {
  if (!guarded) {
    return okCheck("fixture smoke는 실제 운영 config/env/key scope 입력 검사를 열지 않는다.", { fixtureSmoke: true });
  }

  const configPath = readString(manifest.configPath);
  const envFilePath = readString(manifest.envFilePath);
  const artifactPaths = readStringArray(manifest.artifactPaths);
  const keyScopeEvidence = createKeyScopeEvidence(manifest);
  const fileStatuses = await Promise.all([
    createFileStatus("configPath", configPath, baseDir),
    createFileStatus("envFilePath", envFilePath, baseDir),
  ]);
  const missing = [
    ["configPath", configPath],
    ["envFilePath", envFilePath],
    ["operatorArmEvidenceId", readString(manifest.operatorArmEvidenceId)],
    ["keyScopeEvidenceId", readString(manifest.keyScopeEvidenceId)],
  ].filter(([, value]) => !hasText(value)).map(([name]) => name);
  const pathViolations = [
    ["configPath", configPath],
    ["envFilePath", envFilePath],
    ...artifactPaths.map((artifactPath, index) => [`artifactPaths[${index}]`, artifactPath]),
  ].filter(([, value]) => hasText(value) && !isOutsideRepositoryPath(value)).map(([name, value]) => ({ name, value }));
  const missingFiles = fileStatuses.filter((file) => !file.exists || !file.isFile);

  if (missing.length === 0
    && artifactPaths.length > 0
    && pathViolations.length === 0
    && missingFiles.length === 0
    && keyScopeEvidence.ok) {
    return okCheck("운영자가 지정한 저장소 밖 config/env/evidence 경로가 closeout manifest에 연결됐다.", {
      configPath,
      envFilePath,
      artifactCount: artifactPaths.length,
      keyScope: keyScopeEvidence.evidence,
    });
  }

  return failCheck("운영 config/env/evidence 입력이 부족하거나 저장소 내부 경로를 가리킨다.", {
    missing: artifactPaths.length === 0 ? [...missing, "artifactPaths"] : missing,
    pathViolations,
    missingFiles,
    keyScope: keyScopeEvidence.evidence,
  });
}

function createArtifactFilesCheck(artifactFiles) {
  const unreadable = artifactFiles
    .filter((file) => file.error !== undefined)
    .map((file) => ({ filePath: file.filePath, error: file.error }));
  if (artifactFiles.length > 0 && unreadable.length === 0) {
    return okCheck("closeout manifest가 가리키는 redacted artifact 파일을 모두 읽었다.", {
      artifactCount: artifactFiles.length,
    });
  }

  return failCheck("closeout manifest의 redacted artifact 파일을 읽지 못했다.", {
    artifactCount: artifactFiles.length,
    unreadable,
  });
}

function createOrderPolicyCheck(run) {
  const requestedNotionalKrw = Number(readStringOrNumber(run.requestedNotionalKrw));
  const actual = {
    market: readString(run.market),
    side: readString(run.side),
    orderType: readString(run.orderType),
    timeInForce: normalizeTimeInForce(readString(run.timeInForce)),
    requestedNotionalKrw,
  };
  const ok = actual.market === expectedMarket
    && actual.side === expectedSide
    && actual.orderType === expectedOrderType
    && actual.timeInForce === expectedTimeInForce
    && Number.isFinite(requestedNotionalKrw)
    && requestedNotionalKrw >= minRequestedNotionalKrw
    && requestedNotionalKrw <= maxRequestedNotionalKrw;

  if (ok) {
    return okCheck("실거래 cleanup 주문이 KRW-BTC 단일 BUY LIMIT post_only 소액 상한을 만족한다.", actual);
  }

  return failCheck("실거래 cleanup 주문 정책이 Issue #206 허용 범위를 벗어난다.", {
    expected: {
      market: expectedMarket,
      side: expectedSide,
      orderType: expectedOrderType,
      timeInForce: expectedTimeInForce,
      minRequestedNotionalKrw,
      maxRequestedNotionalKrw,
    },
    actual,
  });
}

function createOrderLifecycleCheck(run) {
  const submittedAtMs = readTimestampMs(run.submittedAt);
  const cancelRequestedAtMs = readTimestampMs(run.cancelRequestedAt);
  const terminalCancelConfirmedAtMs = readTimestampMs(run.terminalCancelConfirmedAt);
  const terminalState = normalizeTerminalState(readString(run.terminalState));
  const sameChain = hasSameOrderChain(run);
  const nowMs = Date.now();
  const timestampsNotFuture = [submittedAtMs, cancelRequestedAtMs, terminalCancelConfirmedAtMs]
    .every((timestampMs) => timestampMs !== undefined && timestampMs <= nowMs);
  const ok = submittedAtMs !== undefined
    && cancelRequestedAtMs !== undefined
    && terminalCancelConfirmedAtMs !== undefined
    && submittedAtMs <= cancelRequestedAtMs
    && cancelRequestedAtMs <= terminalCancelConfirmedAtMs
    && timestampsNotFuture
    && terminalState === "CANCEL"
    && sameChain;

  if (ok) {
    return okCheck("submit -> cancel requested -> terminal cancel evidence가 같은 주문 chain으로 이어진다.", {
      submittedAt: run.submittedAt,
      cancelRequestedAt: run.cancelRequestedAt,
      terminalCancelConfirmedAt: run.terminalCancelConfirmedAt,
      terminalState,
      sameChain,
      timestampsNotFuture,
    });
  }

  return failCheck("submit/cancel/terminal cancel lifecycle evidence가 부족하거나 순서가 맞지 않는다.", {
    submittedAt: run.submittedAt ?? null,
    cancelRequestedAt: run.cancelRequestedAt ?? null,
    terminalCancelConfirmedAt: run.terminalCancelConfirmedAt ?? null,
    terminalState,
    sameChain,
    timestampsNotFuture,
  });
}

function createReconcileCloseoutCheck(manifest, run) {
  const reconcile = readRecord(manifest.reconcile);
  const values = {
    "run.openExposureKrw": readNumber(run.openExposureKrw),
    "run.openOrderCount": readNumber(run.openOrderCount),
    "run.reconcileMismatchCount": readNumber(run.reconcileMismatchCount),
    "run.untrackedFillCount": readNumber(run.untrackedFillCount),
    "run.manualReviewCount": readNumber(run.manualReviewCount),
    "reconcile.openExposureKrw": readNumber(reconcile.openExposureKrw),
    "reconcile.openOrderCount": readNumber(reconcile.openOrderCount),
    "reconcile.mismatchCount": readNumber(reconcile.mismatchCount),
    "reconcile.untrackedFillCount": readNumber(reconcile.untrackedFillCount),
    "reconcile.manualReviewCount": readNumber(reconcile.manualReviewCount),
  };
  const ok = Object.values(values).every((value) => value === 0);

  if (ok) {
    return okCheck("terminal cancel 이후 open exposure/reconcile/manual review가 모두 0으로 닫혔다.", values);
  }

  return failCheck("terminal cancel 이후 open exposure/reconcile/manual review가 남아 있다.", values);
}

function createZeroCounterCheck(counters) {
  const values = Object.fromEntries(requiredCounterNames.map((name) => [name, readNumber(counters[name])]));
  const missing = Object.entries(values).filter(([, value]) => value === undefined).map(([name]) => name);
  const nonZero = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== 0)
    .map(([name, value]) => ({ name, value }));

  if (missing.length === 0 && nonZero.length === 0) {
    return okCheck("closeout failure counter가 모두 0이다.", values);
  }

  return failCheck("closeout failure counter가 누락되었거나 0이 아니다.", { values, missing, nonZero });
}

function createTelegramTuiEvidenceCheck(manifest) {
  const telegram = readRecord(manifest.telegram);
  const evidence = readRecord(telegram.evidenceIds);
  const requiredTelegram = ["startup", "liveOrderCapable", "orderSubmitted", "cancelRequested", "cancelConfirmed"];
  const missingTelegram = requiredTelegram.filter((name) => !hasText(readString(evidence[name])));
  const tuiEvidenceId = readString(readRecord(manifest.tui).evidenceId);

  if (missingTelegram.length === 0 && hasText(tuiEvidenceId)) {
    return okCheck("Telegram lifecycle와 TUI 상태 evidence가 closeout manifest에 연결됐다.", {
      telegramEvidenceCount: requiredTelegram.length,
      tuiEvidenceId,
    });
  }

  return failCheck("Telegram lifecycle 또는 TUI 상태 evidence가 부족하다.", {
    missingTelegram,
    tuiEvidenceId: tuiEvidenceId ?? null,
  });
}

function createSourceSecurityScanCheck(sourceScan, options) {
  const unsafeMatches = readArray(sourceScan.unsafeMatches);
  const secretMatches = readArray(sourceScan.secretMatches);
  const commands = readStringArray(sourceScan.commands);
  const status = readString(sourceScan.status);
  const evidenceShapeOk = commands.length > 0
    && Array.isArray(sourceScan.unsafeMatches)
    && Array.isArray(sourceScan.secretMatches);
  const commandEvidence = options.guarded
    ? createSourceScanCommandEvidence(commands)
    : { ok: true, fixtureSmoke: true };
  const ok = status === "passed"
    && evidenceShapeOk
    && commandEvidence.ok
    && unsafeMatches.length === 0
    && secretMatches.length === 0;

  if (ok) {
    return okCheck("source/security scan이 금지 주문 경계와 secret/raw payload 후보를 새로 열지 않았다고 기록했다.", {
      status,
      commandCount: commands.length,
      commandEvidence,
    });
  }

  return failCheck("source/security scan 결과가 없거나 금지 후보가 남아 있다.", {
    status: status ?? null,
    commandCount: commands.length,
    evidenceShapeOk,
    commandEvidence,
    unsafeMatches,
    secretMatches,
  });
}

function createRedactionScanCheck(inputs) {
  const findings = [];
  let scannedBytes = 0;
  for (const input of inputs) {
    const rawText = input.rawText ?? "";
    scannedBytes += Buffer.byteLength(rawText, "utf8");
    for (const { label, pattern } of sensitivePatterns) {
      if (pattern.test(rawText)) {
        findings.push({ input: input.label, label });
      }
    }
  }

  if (findings.length === 0) {
    return okCheck("manifest와 redacted artifact에 raw secret/provider/order 후보 문자열이 없다.", { scannedBytes });
  }

  return failCheck("manifest 또는 artifact에 secret/raw provider 후보 문자열이 있다.", { findings, scannedBytes });
}

function createReadinessAuditCheck(manifest) {
  const audit = readRecord(manifest.readinessAudit);
  const status = readString(audit.status);
  const evidenceId = readString(audit.evidenceId);
  if (status === "PASS" && hasText(evidenceId)) {
    return okCheck("finish-readiness-audit PASS evidence가 closeout manifest에 연결됐다.", { status, evidenceId });
  }

  return failCheck("실거래 closeout manifest에는 finish-readiness-audit PASS evidence가 필요하다.", {
    status: status ?? null,
    evidenceId: evidenceId ?? null,
  });
}

function createMetrics(run, counters) {
  return {
    requestedNotionalKrw: readNumber(run.requestedNotionalKrw) ?? null,
    terminalCancelConfirmed: normalizeTerminalState(readString(run.terminalState)) === "CANCEL",
    openExposureKrw: readNumber(run.openExposureKrw) ?? null,
    crashCount: readNumber(counters.crashCount) ?? null,
    unhandledRejectionCount: readNumber(counters.unhandledRejectionCount) ?? null,
    duplicateOrderCount: readNumber(counters.duplicateOrderCount) ?? null,
    reconcileMismatchCount: readNumber(counters.reconcileMismatchCount) ?? null,
    untrackedFillCount: readNumber(counters.untrackedFillCount) ?? null,
    liveOrderCleanupFailureCount: readNumber(counters.liveOrderCleanupFailureCount) ?? null,
  };
}

function createEmptyMetrics() {
  return {
    requestedNotionalKrw: null,
    terminalCancelConfirmed: false,
    openExposureKrw: null,
    crashCount: null,
    unhandledRejectionCount: null,
    duplicateOrderCount: null,
    reconcileMismatchCount: null,
    untrackedFillCount: null,
    liveOrderCleanupFailureCount: null,
  };
}

async function readArtifactFiles(artifactPaths, baseDir) {
  const files = [];
  for (const artifactPath of artifactPaths) {
    const resolved = resolveInputPath(artifactPath, baseDir);
    try {
      files.push({ filePath: resolved, rawText: await readFile(resolved, "utf8") });
    } catch (error) {
      files.push({
        filePath: resolved,
        rawText: JSON.stringify({ artifact_read_error: toErrorMessage(error) }),
        error: toErrorMessage(error),
      });
    }
  }
  return files;
}

async function readJsonFile(filePath, baseDir) {
  const resolved = resolveInputPath(filePath, baseDir);
  let rawText = "";
  try {
    rawText = await readFile(resolved, "utf8");
    return {
      filePath: resolved,
      rawText,
      value: JSON.parse(rawText),
      error: undefined,
    };
  } catch (error) {
    return {
      filePath: resolved,
      rawText,
      value: undefined,
      error: toErrorMessage(error),
    };
  }
}

async function writeFixtureManifest(artifactDir) {
  const artifactPath = path.join(artifactDir, "issue-206-live-ops-closeout-artifact.fixture.json");
  const manifestPath = path.join(artifactDir, "issue-206-live-ops-closeout-manifest.fixture.json");
  const startedAt = "2026-06-15T00:00:00.000Z";
  const cancelRequestedAt = "2026-06-15T00:00:05.000Z";
  const terminalCancelConfirmedAt = "2026-06-15T00:00:10.000Z";
  const artifact = {
    kind: "ISSUE_206_LIVE_OPS_REAL_ARM_FIXTURE",
    status: "PASSED",
    market: expectedMarket,
    submittedAt: startedAt,
    cancelRequestedAt,
    terminalCancelConfirmedAt,
    terminalState: "cancel",
    openExposureKrw: 0,
    note: "fixture smoke artifact - no live API side effect",
  };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const manifest = {
    fixture: true,
    issue: expectedIssue,
    mode: expectedMode,
    command: "corepack pnpm live:ops -- --config /tmp/issue-206-live-ops.fixture.json --env-file /tmp/issue-206-live-ops.fixture.env --tui",
    configPath: "/tmp/issue-206-live-ops.fixture.json",
    envFilePath: "/tmp/issue-206-live-ops.fixture.env",
    operatorArmEvidenceId: "issue-206-operator-arm-fixture",
    keyScopeEvidenceId: "issue-206-key-scope-fixture",
    keyScope: {
      grantedScopes: requiredKeyScopes,
      forbiddenScopesAbsent: ["출금하기"],
      withdrawalEnabled: false,
    },
    artifactPaths: [artifactPath],
    run: {
      market: expectedMarket,
      side: expectedSide,
      orderType: expectedOrderType,
      timeInForce: "post_only",
      requestedNotionalKrw: "5000",
      submittedAt: startedAt,
      cancelRequestedAt,
      terminalCancelConfirmedAt,
      terminalState: "cancel",
      identifierSuffix: "fixture-identifier",
      cancelIdentifierSuffix: "fixture-identifier",
      brokerOrderIdSuffix: "fixture-order",
      cancelBrokerOrderIdSuffix: "fixture-order",
      openExposureKrw: 0,
      openOrderCount: 0,
      reconcileMismatchCount: 0,
      untrackedFillCount: 0,
      manualReviewCount: 0,
    },
    reconcile: {
      openExposureKrw: 0,
      openOrderCount: 0,
      mismatchCount: 0,
      untrackedFillCount: 0,
      manualReviewCount: 0,
    },
    counters: {
      crashCount: 0,
      unhandledRejectionCount: 0,
      duplicateOrderCount: 0,
      reconcileMismatchCount: 0,
      untrackedFillCount: 0,
      liveOrderCleanupFailureCount: 0,
    },
    telegram: {
      evidenceIds: {
        startup: "fixture-telegram-startup",
        liveOrderCapable: "fixture-telegram-live-order-capable",
        orderSubmitted: "fixture-telegram-order-submitted",
        cancelRequested: "fixture-telegram-cancel-requested",
        cancelConfirmed: "fixture-telegram-cancel-confirmed",
      },
    },
    tui: {
      evidenceId: "fixture-tui-status",
    },
    sourceScan: {
      status: "passed",
      commands: ["fixture source scan"],
      unsafeMatches: [],
      secretMatches: [],
    },
    readinessAudit: {
      status: "PASS",
      evidenceId: "fixture-readiness-audit",
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { artifactPath, manifestPath };
}

function createSummary(input) {
  const status = determineStatus(input.checks);
  return {
    issue: expectedIssue,
    runId: input.runId,
    status,
    input: input.inputMode,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    artifacts: input.artifacts,
    metrics: input.metrics,
    checks: input.checks,
  };
}

function determineStatus(checks) {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.includes("fail")) {
    return "failed";
  }
  if (statuses.includes("skipped")) {
    return "skipped";
  }
  return "passed";
}

async function writeArtifacts(summary, artifacts) {
  await mkdir(path.dirname(artifacts.summaryPath), { recursive: true });
  await writeFile(artifacts.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(artifacts.reportPath, renderReport(summary), "utf8");
}

async function writeFailureSummary(error, options) {
  const startedAt = new Date();
  const artifactDir = path.resolve(expandHome(options.artifactDir ?? process.env.SEEMIRAI_LIVE_OPS_REAL_ARM_ARTIFACT_DIR ?? defaultArtifactDir));
  const runId = randomUUID();
  const artifacts = createArtifactPaths({ artifactDir, startedAt, runId });
  const summary = createSummary({
    runId,
    startedAt,
    inputMode: "script_failure",
    artifacts,
    metrics: createEmptyMetrics(),
    checks: {
      scriptFailure: failCheck("Issue #206 live:ops closeout validator 실행 중 예외가 발생했다.", {
        error: toErrorMessage(error),
      }),
    },
  });
  await writeArtifacts(summary, artifacts).catch(() => undefined);
  return summary;
}

function renderReport(summary) {
  const lines = [
    "# Issue #206 live:ops 실거래 closeout 검증",
    "",
    `- status: ${summary.status}`,
    `- input: ${summary.input}`,
    `- runId: ${summary.runId}`,
    `- startedAt: ${summary.startedAt}`,
    `- finishedAt: ${summary.finishedAt}`,
    "",
    "## Checks",
    "",
  ];
  for (const [name, check] of Object.entries(summary.checks)) {
    lines.push(`- ${name}: ${check.status} - ${check.message}`);
  }
  lines.push("", "## Metrics", "", "```json", JSON.stringify(summary.metrics, null, 2), "```", "");
  return `${lines.join("\n")}\n`;
}

function printSummary(summary, options) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`status: ${summary.status}\n`);
  process.stdout.write(`summary: ${summary.artifacts.summaryPath}\n`);
  process.stdout.write(`report: ${summary.artifacts.reportPath}\n`);
}

function createArtifactPaths(input) {
  const timestamp = input.startedAt.toISOString().replace(/[:.]/g, "-");
  const prefix = `issue-206-live-ops-real-arm-${timestamp}-${input.runId.slice(0, 8)}`;
  return {
    summaryPath: path.join(input.artifactDir, `${prefix}-summary.json`),
    reportPath: path.join(input.artifactDir, `${prefix}-report.md`),
  };
}

function parseArgs(argv) {
  const options = {
    artifactDir: undefined,
    fixtureSmoke: false,
    help: false,
    json: false,
    manifestPath: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact-dir":
        options.artifactDir = readValue(argv, index, arg);
        index += 1;
        break;
      case "--fixture-smoke":
        options.fixtureSmoke = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--manifest":
        options.manifestPath = readValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`지원하지 않는 인자입니다: ${arg}`);
    }
  }
  return options;
}

function parseArgsForFailure(argv) {
  const options = { artifactDir: undefined, json: argv.includes("--json") };
  const artifactDirIndex = argv.indexOf("--artifact-dir");
  if (artifactDirIndex >= 0 && argv[artifactDirIndex + 1] !== undefined && !argv[artifactDirIndex + 1].startsWith("--")) {
    options.artifactDir = argv[artifactDirIndex + 1];
  }
  return options;
}

function readValue(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} 값이 필요합니다.`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Issue #206 live:ops real-arm closeout validator.

Usage:
  node scripts/run-live-ops-real-arm-closeout.mjs --fixture-smoke [--json] [--artifact-dir <path>]
  SEEMIRAI_RUN_LIVE_OPS_REAL_ARM_CLOSEOUT=1 node scripts/run-live-ops-real-arm-closeout.mjs --manifest <path> [--json] [--artifact-dir <path>]

Options:
  --manifest <path>       저장소 밖 redacted closeout manifest JSON.
  --artifact-dir <path>   summary/report 출력 디렉터리. 기본값은 ~/vaults/99_운영/seemirai-live-ops-real-arm-closeout.
  --fixture-smoke         live/API side effect 없이 결정적 manifest 검증만 실행.
  --json                  summary JSON을 stdout으로 출력.
`);
}

function okCheck(message, evidence = {}) {
  return { status: "ok", message, evidence };
}

function failCheck(message, evidence = {}) {
  return { status: "fail", message, evidence };
}

function skippedCheck(message, evidence = {}) {
  return { status: "skipped", message, evidence };
}

function hasSameOrderChain(run) {
  const identifier = readString(run.identifierSuffix);
  const cancelIdentifier = readString(run.cancelIdentifierSuffix);
  if (isUsableOrderEvidenceSuffix(identifier) && identifier === cancelIdentifier) {
    return true;
  }
  const brokerOrderId = readString(run.brokerOrderIdSuffix);
  const cancelBrokerOrderId = readString(run.cancelBrokerOrderIdSuffix);
  return isUsableOrderEvidenceSuffix(brokerOrderId) && brokerOrderId === cancelBrokerOrderId;
}

function isLiveOpsCommand(command, configPath, envFilePath) {
  if (!hasText(command) || !hasText(configPath) || !hasText(envFilePath)) {
    return false;
  }
  const tokens = command.trim().split(/\s+/u);
  const separatorIndex = tokens.indexOf("--");
  if (tokens[0] !== "corepack" || tokens[1] !== "pnpm" || tokens[2] !== "live:ops" || separatorIndex !== 3) {
    return false;
  }
  if (tokens.includes("--fixture-smoke")
    || tokens.includes("--dry-run")
    || tokens.includes("--attach")
    || tokens.includes("--help")
    || tokens.includes("-h")) {
    return false;
  }
  const configIndex = tokens.indexOf("--config");
  const envFileIndex = tokens.indexOf("--env-file");
  return configIndex > separatorIndex
    && envFileIndex > separatorIndex
    && tokens[configIndex + 1] === configPath
    && tokens[envFileIndex + 1] === envFilePath
    && tokens.includes("--tui");
}

async function createFileStatus(name, value, baseDir) {
  if (!hasText(value)) {
    return { name, value: value ?? null, exists: false, isFile: false, error: "missing" };
  }

  const filePath = resolveInputPath(value, baseDir);
  try {
    const stats = await stat(filePath);
    return { name, value: filePath, exists: true, isFile: stats.isFile() };
  } catch (error) {
    return { name, value: filePath, exists: false, isFile: false, error: toErrorMessage(error) };
  }
}

function createKeyScopeEvidence(manifest) {
  const keyScope = readRecord(manifest.keyScope);
  const grantedScopes = readStringArray(keyScope.grantedScopes ?? keyScope.allowedScopes);
  const forbiddenScopesAbsent = readStringArray(keyScope.forbiddenScopesAbsent);
  const withdrawalEnabled = keyScope.withdrawalEnabled;
  const missingRequiredScopes = requiredKeyScopes.filter((scope) => !grantedScopes.includes(scope));
  const extraGrantedScopes = grantedScopes.filter((scope) => !requiredKeyScopes.includes(scope));
  const forbiddenGrantedScopes = grantedScopes.filter(isForbiddenKeyScope);
  const withdrawalAbsenceRecorded = withdrawalEnabled === false || forbiddenScopesAbsent.some(isWithdrawalScope);
  const ok = grantedScopes.length > 0
    && missingRequiredScopes.length === 0
    && extraGrantedScopes.length === 0
    && forbiddenGrantedScopes.length === 0
    && withdrawalAbsenceRecorded;

  return {
    ok,
    evidence: {
      grantedScopes,
      forbiddenScopesAbsent,
      withdrawalEnabled: typeof withdrawalEnabled === "boolean" ? withdrawalEnabled : null,
      missingRequiredScopes,
      extraGrantedScopes,
      forbiddenGrantedScopes,
      withdrawalAbsenceRecorded,
    },
  };
}

function createSourceScanCommandEvidence(commands) {
  const commandChecks = commands.map((command) => {
    const usesRipgrep = /\brg\b/u.test(command);
    const hasLineNumber = /(?:^|\s)(?:-n|--line-number)(?:\s|$)/u.test(command);
    const scansExpectedPaths = /\b(?:src|scripts)\b/u.test(command) && /\b(?:docs|config|scripts|src)\b/u.test(command);
    const checksUnsafeOrderBoundary = /ord_type|withdraw|출금|deposit|입금|leverage|futures|margin|시장가|best/u.test(command);
    const checksSecretBoundary = /access_key|secret_key|Authorization|JWT|telegram_bot_token|raw_provider|raw_order|botToken/u.test(command);
    return {
      command,
      usesRipgrep,
      hasLineNumber,
      scansExpectedPaths,
      checksUnsafeOrderBoundary,
      checksSecretBoundary,
    };
  });
  const hasUnsafeBoundaryScan = commandChecks.some((check) => check.usesRipgrep
    && check.hasLineNumber
    && check.scansExpectedPaths
    && check.checksUnsafeOrderBoundary);
  const hasSecretBoundaryScan = commandChecks.some((check) => check.usesRipgrep
    && check.hasLineNumber
    && check.scansExpectedPaths
    && check.checksSecretBoundary);

  return {
    ok: hasUnsafeBoundaryScan && hasSecretBoundaryScan,
    hasUnsafeBoundaryScan,
    hasSecretBoundaryScan,
    commandChecks,
  };
}

function isUsableOrderEvidenceSuffix(value) {
  if (!hasText(value)) {
    return false;
  }
  const text = value.trim();
  const normalized = text.toLowerCase().replace(/[\s"'`]/gu, "");
  const bracketless = normalized.replace(/[<>\[\](){}]/gu, "");
  const placeholderWords = new Set(["redacted", "masked", "hidden", "removed", "secret", "token", "identifier", "uuid", "orderid"]);
  const alnumCount = (text.match(/[a-z0-9]/giu) ?? []).length;
  return text.length >= 6
    && alnumCount >= 4
    && !placeholderWords.has(bracketless)
    && !/^(?:x+|\*+|-+|_+|\.+)$/u.test(normalized);
}

function isForbiddenKeyScope(scope) {
  const normalized = scope.trim().toLowerCase();
  return forbiddenKeyScopeMarkers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function isWithdrawalScope(scope) {
  const normalized = scope.trim().toLowerCase();
  return withdrawalScopeMarkers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function normalizeTerminalState(value) {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "CANCEL" || normalized === "CANCELED" || normalized === "CANCELLED") {
    return "CANCEL";
  }
  return normalized;
}

function normalizeTimeInForce(value) {
  return value?.trim().toUpperCase().replace(/-/g, "_");
}

function readTimestampMs(value) {
  const text = readString(value);
  if (text === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readNumber(value) {
  const number = Number(readStringOrNumber(value));
  return Number.isFinite(number) ? number : undefined;
}

function readString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringOrNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return readString(value);
}

function readRecord(value) {
  return isRecord(value) ? value : {};
}

function readArray(value) {
  return Array.isArray(value) ? value : [];
}

function readStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isOutsideRepositoryPath(value) {
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) {
    return false;
  }
  const resolved = path.resolve(expanded);
  const relative = path.relative(repositoryRoot, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

function resolveInputPath(filePath, baseDir) {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function expandHome(value) {
  if (typeof value !== "string") {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
