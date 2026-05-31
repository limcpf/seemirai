import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = path.join(process.cwd(), "scripts", "analyze-m11-threshold-calibration.mjs");

describe("M11 threshold calibration report script", () => {
  it("renders Markdown and JSON report from fixture source artifact summaries", async () => {
    const fixture = await writeFixtureEvidence();
    const outputPath = path.join(fixture.root, "m11-report.md");

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--output", outputPath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;
    const markdown = await readFile(outputPath, "utf8");

    expect(report.status).toBe("passed");
    expect(report.aggregate.metrics.paperOrderSubmittedCount).toBe(2130);
    expect(report.reasonBreakdown.cost.totalCount).toBe(4319);
    expect(report.reasonBreakdown.risk.totalCount).toBe(8697);
    expect(report.thresholdRelaxationBlocked).toBe(true);
    expect(report.thresholdCandidates).toContainEqual(
      expect.objectContaining({
        key: "relax_alpha_thresholds",
        status: "blocked",
      }),
    );
    expect(report.riskInteractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "expected_loss_limit_review" }),
        expect.objectContaining({ kind: "order_notional_limit_review" }),
      ]),
    );
    expect(markdown).toContain("판정: 통과");
    expect(markdown).toContain("전략 threshold 완화");
    expect(markdown).toContain("추적 정보");
    await expect(stat(outputPath)).resolves.toBeDefined();
  });

  it("fails closed when source artifacts contain live order API calls", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        liveOrderApiCalls: 1,
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--paper-config", path.join(fixture.root, "missing-paper.json"), "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.liveOrderApiCalls",
      }),
    );
    expect(report.thresholdCandidates).toEqual([]);
  });

  it("writes an inactive conservative profile proposal without mutating paper config", async () => {
    const fixture = await writeFixtureEvidence();
    const proposalPath = path.join(fixture.root, "m11-profile-proposal.json");
    const configPath = path.join(process.cwd(), "config", "paper.json");
    const beforeConfig = await readFile(configPath, "utf8");

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--proposal-output", proposalPath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;
    const proposal = JSON.parse(await readFile(proposalPath, "utf8")) as CalibrationProfileProposalJson;
    const afterConfig = await readFile(configPath, "utf8");

    expect(afterConfig).toBe(beforeConfig);
    expect(report.outputs.profileProposalPath).toBe(proposalPath);
    expect(report.profileProposal.active).toBe(false);
    expect(proposal.active).toBe(false);
    expect(proposal.activationRequired).toBe(true);
    expect(proposal.safety.defaultConfigMutation).toBe(false);
    expect(proposal.patchOperations.length).toBeGreaterThan(0);
    expect(proposal.patchOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/strategyParameters/trend_following/max_spread_bps",
          value: "7",
          from: "8",
          to: "7",
          aggressiveness: "conservative",
        }),
        expect.objectContaining({
          path: "/strategyParameters/mean_reversion/min_cost_adjusted_margin_bps",
          value: "2",
          from: "0",
          to: "2",
          aggressiveness: "conservative",
        }),
      ]),
    );
    expect(proposal.patchOperations.map((operation) => operation.candidateKey)).not.toContain("relax_alpha_thresholds");
    expect(proposal.blockedCandidates).toContainEqual(expect.objectContaining({ key: "relax_alpha_thresholds" }));
    expect(proposal.manualReviewItems).toContainEqual(expect.objectContaining({ candidateKey: "cost_safety_buffer_bps" }));
  });

  it("keeps user-facing Korean summary separate from trace identifiers", async () => {
    const fixture = await writeFixtureEvidence();

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.operatorSummary).toContain("threshold 완화 후보는 기본 제안으로 승격하지 않습니다");
    expect(report.action).toContain("기본 threshold 완화는 보류");
    expect(report.trace.sourceArtifacts.rawEventLogPath).toContain("-events.jsonl");
    expect(report.thresholdCandidates[0]?.title).toBe("전략 threshold 완화");
  });

  it("supports document-only reports from the committed evidence table shape", async () => {
    const { stdout } = await execFileAsync("node", [
      scriptPath,
      "--evidence",
      "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
      "--document-only",
      "--json",
    ]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.status).toBe("passed");
    expect(report.days).toHaveLength(3);
    expect(report.days[0]?.sourceKind).toBe("evidence_document");
    expect(report.thresholdRelaxationBlocked).toBe(true);
  });
});

async function runScriptAllowingFailure(args: string[]) {
  try {
    const { stdout } = await execFileAsync("node", [scriptPath, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "" };
  }
}

async function writeFixtureEvidence(options: { aggregateMetrics?: Partial<CalibrationMetricSummary> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-m11-calibration-"));
  const artifactDir = path.join(root, "trading-soak");
  const prefix = "m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee";
  await mkdir(artifactDir);
  await writeSummary(path.join(artifactDir, `${prefix}-summary.json`), null, {
    blockingReasonCounts: {
      "cost:cost_margin_insufficient": 4319,
      "hold:fixture_waiting_for_signal": 4319,
      "risk:expected_loss_limit_exceeded": 4319,
      "risk:order_notional_limit_exceeded": 4378,
    },
    costRejectedCount: 4319,
    riskRejectedCount: 6508,
    paperOrderSubmittedCount: 2130,
    paperFillCount: 2130,
    ...options.aggregateMetrics,
  });
  await Promise.all(
    [1, 2, 3].map((day) =>
      writeSummary(path.join(artifactDir, `${prefix}-day-${day}-summary.json`), day, {
        blockingReasonCounts: {
          "cost:cost_margin_insufficient": 1440,
          "risk:expected_loss_limit_exceeded": 1440,
          "risk:order_notional_limit_exceeded": 1400 - day,
        },
        costRejectedCount: 1440,
        riskRejectedCount: 2200 - day,
        paperOrderSubmittedCount: 700 + day,
        paperFillCount: 700 + day,
      }),
    ),
  );
  const evidencePath = path.join(root, "evidence.md");
  await writeFile(evidencePath, createEvidenceMarkdown({ artifactDir, prefix }), "utf8");
  return { root, artifactDir, evidencePath };
}

async function writeSummary(summaryPath: string, day: number | null, overrides: Partial<CalibrationMetricSummary>) {
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        status: "passed",
        input: "upbit_public_websocket_paper_trading_loop",
        runId: "fixture-run",
        startedAt: "2026-05-25T11:01:10.044Z",
        finishedAt: "2026-05-26T11:01:10.044Z",
        day,
        metrics: createMetrics(overrides),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createMetrics(overrides: Partial<CalibrationMetricSummary> = {}): CalibrationMetricSummary {
  return {
    costSummary: {
      evaluatedCount: 12957,
      allowedCount: 8638,
      rejectedCount: 4319,
      averageCostBps: "13",
      averageRequiredReturnBps: "23",
      averageMarginBps: "-1.333333333333",
    },
    slippageSummary: {
      observedFillCount: 2130,
      averageSlippageBps: "0",
      minSlippageBps: "0",
      maxSlippageBps: "0",
    },
    holdReasonCounts: {
      fixture_waiting_for_signal: 4319,
    },
    discardReasonCounts: {},
    blockingReasonCounts: {},
    costRejectedCount: 4319,
    riskRejectedCount: 6508,
    paperOrderSubmittedCount: 2130,
    paperFillCount: 2130,
    fillRate: 1,
    liveOrderApiCalls: 0,
    ...overrides,
  };
}

function createEvidenceMarkdown(input: { artifactDir: string; prefix: string }) {
  return `# M9 #68 72시간 paper trading soak evidence

- 확인일: 2026-05-31
- 대상 issue: #68 \`[Ops] M9 72시간 paper trading 관측\`
- run prefix: \`${input.prefix}\`
- 판정: passed

## Source artifacts

- aggregate summary: \`${path.join(input.artifactDir, `${input.prefix}-summary.json`)}\`
- aggregate report: \`${path.join(input.artifactDir, `${input.prefix}-report.md`)}\`
- day reports: \`${path.join(input.artifactDir, `${input.prefix}-day-{1,2,3}-report.md`)}\`
- day summaries: \`${path.join(input.artifactDir, `${input.prefix}-day-{1,2,3}-summary.json`)}\`
- 3일 비교 report: \`${path.join(input.artifactDir, "m9-3day-trading-soak-comparison.md")}\`
- raw event log: \`${path.join(input.artifactDir, `${input.prefix}-events.jsonl`)}\`

## Aggregate result

| 항목 | 값 |
| --- | --- |
| status | \`passed\` |
| paperOrderSubmittedCount | \`2130\` |
| paperFillCount | \`2130\` |
| fillRate | \`1\` |
| liveOrderApiCalls | \`0\` |

## Cost, slippage, and blocking

| 항목 | 값 |
| --- | --- |
| costSummary.evaluatedCount | \`12957\` |
| costSummary.allowedCount | \`8638\` |
| costSummary.rejectedCount | \`4319\` |
| averageCostBps | \`13\` |
| averageRequiredReturnBps | \`23\` |
| averageMarginBps | \`-1.333333333333\` |
| slippageSummary.observedFillCount | \`2130\` |
| averageSlippageBps | \`0\` |
| holdReasonCounts | \`{"fixture_waiting_for_signal":4319}\` |
| discardReasonCounts | \`{}\` |
| costRejectedCount | \`4319\` |
| riskRejectedCount | \`6508\` |
| blockingReasonCounts | \`{"cost:cost_margin_insufficient":4319,"hold:fixture_waiting_for_signal":4319,"risk:expected_loss_limit_exceeded":4319,"risk:order_notional_limit_exceeded":4378}\` |

## Day comparison

| 일차 | 기간 | status | cycles | submitted/fill | fillRate | cost evaluated | averageMarginBps | riskRejectedCount | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 | \`2026-05-25T11:01:10.044Z\` - \`2026-05-26T11:01:10.044Z\` | passed | \`1439\` | \`664 / 664\` | \`1\` | \`4317\` | \`-1.333333333333\` | \`2214\` | \`cost:cost_margin_insufficient=1439\`, \`risk:expected_loss_limit_exceeded=1439\`, \`risk:order_notional_limit_exceeded=1550\` |
| Day 2 | \`2026-05-26T11:01:10.044Z\` - \`2026-05-27T11:01:10.044Z\` | passed | \`1440\` | \`668 / 668\` | \`1\` | \`4320\` | \`-1.333333333333\` | \`2212\` | \`cost:cost_margin_insufficient=1440\`, \`risk:expected_loss_limit_exceeded=1440\`, \`risk:order_notional_limit_exceeded=1544\` |
| Day 3 | \`2026-05-27T11:01:10.044Z\` - \`2026-05-28T11:01:10.044Z\` | passed | \`1440\` | \`798 / 798\` | \`1\` | \`4320\` | \`-1.333333333333\` | \`2082\` | \`cost:cost_margin_insufficient=1440\`, \`risk:expected_loss_limit_exceeded=1440\`, \`risk:order_notional_limit_exceeded=1284\` |

## Validation command

\`\`\`sh
node scripts/validate-m9-paper-soak-evidence.mjs --artifact-dir ${input.artifactDir} --issue-comment
\`\`\`
`;
}

interface CalibrationReportJson {
  status: string;
  operatorSummary: string;
  action: string;
  aggregate: { metrics: CalibrationMetricSummary };
  days: Array<{ sourceKind: string }>;
  reasonBreakdown: {
    cost: { totalCount: number };
    risk: { totalCount: number };
  };
  thresholdRelaxationBlocked: boolean;
  thresholdCandidates: Array<{ key: string; title: string; status: string }>;
  riskInteractions: Array<{ kind: string }>;
  validation: { failures: Array<{ fieldPath: string }> };
  trace: { sourceArtifacts: { rawEventLogPath: string } };
  outputs: { profileProposalPath: string | null };
  profileProposal: CalibrationProfileProposalJson;
}

interface CalibrationProfileProposalJson {
  active: boolean;
  activationRequired: boolean;
  safety: { defaultConfigMutation: boolean };
  patchOperations: Array<{
    path: string;
    value: string;
    from: string;
    to: string;
    candidateKey: string;
    aggressiveness: string;
  }>;
  manualReviewItems: Array<{ candidateKey: string }>;
  blockedCandidates: Array<{ key: string }>;
}

interface CalibrationMetricSummary {
  costSummary: {
    evaluatedCount: number;
    allowedCount: number;
    rejectedCount: number;
    averageCostBps: string;
    averageRequiredReturnBps: string;
    averageMarginBps: string;
  };
  slippageSummary: {
    observedFillCount: number;
    averageSlippageBps: string;
    minSlippageBps: string;
    maxSlippageBps: string;
  };
  holdReasonCounts: Record<string, number>;
  discardReasonCounts: Record<string, number>;
  blockingReasonCounts: Record<string, number>;
  costRejectedCount: number;
  riskRejectedCount: number;
  paperOrderSubmittedCount: number;
  paperFillCount: number;
  fillRate: number;
  liveOrderApiCalls: number;
}
