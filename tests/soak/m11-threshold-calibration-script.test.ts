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

  it("fails closed when source artifact fill rate is outside the valid range", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        fillRate: 2,
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.fillRate",
      }),
    );
  });

  it("fails closed when source artifact cost summary counts are inconsistent", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        costSummary: {
          evaluatedCount: 3,
          allowedCount: 3,
          rejectedCount: 3,
          averageCostBps: "13",
          averageRequiredReturnBps: "23",
          averageMarginBps: "-1.333333333333",
        },
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary",
      }),
    );
  });

  it("fails closed when source artifact slippage count differs from paper fill count", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        slippageSummary: createSlippageSummary(0),
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.slippageSummary.observedFillCount",
      }),
    );
  });

  it("fails closed when source artifact cost rejected count differs from cost summary", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        costSummary: {
          evaluatedCount: 12957,
          allowedCount: 12957,
          rejectedCount: 0,
          averageCostBps: "13",
          averageRequiredReturnBps: "23",
          averageMarginBps: "-1.333333333333",
        },
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary.rejectedCount",
      }),
    );
  });

  it("fails closed when source artifact explicit hold counts differ from blocking reasons", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        holdReasonCounts: {},
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.holdReasonCounts.fixture_waiting_for_signal",
      }),
    );
  });

  it("fails closed when source artifact aggregate totals do not match days", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        costSummary: {
          evaluatedCount: 12958,
          allowedCount: 8639,
          rejectedCount: 4319,
          averageCostBps: "13",
          averageRequiredReturnBps: "23",
          averageMarginBps: "-1.333333333333",
        },
      },
    });

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(result.stdout) as CalibrationReportJson;

    expect(result.code).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary.evaluatedCount",
      }),
    );
  });

  it("fails closed when source artifact day content disagrees with the expected day", async () => {
    const fixture = await writeFixtureEvidence();
    const dayTwoPath = path.join(fixture.artifactDir, `${fixture.prefix}-day-2-summary.json`);
    const dayTwoSummary = JSON.parse(await readFile(dayTwoPath, "utf8")) as { day: number };
    await writeFile(dayTwoPath, JSON.stringify({ ...dayTwoSummary, day: 1 }, null, 2), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("day must match expected Day 2");
  });

  it("accepts existing source artifacts that omit top-level day fields", async () => {
    const fixture = await writeFixtureEvidence();
    await Promise.all(
      [null, 1, 2, 3].map(async (day) => {
        const summaryPath =
          day === null ? path.join(fixture.artifactDir, `${fixture.prefix}-summary.json`) : path.join(fixture.artifactDir, `${fixture.prefix}-day-${day}-summary.json`);
        const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
        delete summary.day;
        await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
      }),
    );

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.status).toBe("passed");
    expect(report.days).toHaveLength(3);
  });

  it("accepts source artifact fill rate rounded to six decimal places", async () => {
    const fixture = await writeFixtureEvidence({
      aggregateMetrics: {
        paperOrderSubmittedCount: 3,
        paperFillCount: 1,
        fillRate: 0.333333,
        slippageSummary: createSlippageSummary(1),
      },
      dayMetrics: [
        { paperOrderSubmittedCount: 1, paperFillCount: 1, fillRate: 1, slippageSummary: createSlippageSummary(1) },
        { paperOrderSubmittedCount: 1, paperFillCount: 0, fillRate: 0, slippageSummary: createSlippageSummary(0) },
        { paperOrderSubmittedCount: 1, paperFillCount: 0, fillRate: 0, slippageSummary: createSlippageSummary(0) },
      ],
    });

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.status).toBe("passed");
    expect(report.validation.failures).toEqual([]);
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

  it("falls back to committed evidence tables when source artifact summaries are unavailable", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.status).toBe("passed");
    expect(report.aggregate.sourceKind).toBe("evidence_document");
    expect(report.days[0]?.sourceKind).toBe("evidence_document");
    expect(report.aggregate.metrics.liveOrderApiCalls).toBe(0);
  });

  it("does not coerce empty committed evidence numeric cells to zero", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("| liveOrderApiCalls | `0` |", "| liveOrderApiCalls |  |"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("table.liveOrderApiCalls is required");
  });

  it("rejects committed evidence aggregate numeric cells with non-decimal notation", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("| liveOrderApiCalls | `0` |", "| liveOrderApiCalls | `0x0` |"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("table.liveOrderApiCalls must be a decimal number");
  });

  it("rejects committed evidence integer cells with trailing text", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("`cost:cost_margin_insufficient=1439`", "`cost:cost_margin_insufficient=1439abc`"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("blockingReason.count must be a safe integer");
  });

  it("rejects committed evidence blocking reason items with extra delimiters", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("cost:cost_margin_insufficient=1439", "cost:cost_margin_insufficient=1439=stale"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("blockingReason.item must match reason=count");
  });

  it("rejects committed evidence submitted/fill cells with trailing text", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("`664 / 664`", "`664abc / 664`"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("day.paperOrderSubmittedCount must be a safe integer");
  });

  it("rejects empty committed evidence day blocking reason cells", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(
      fixture.evidencePath,
      markdown.replace(
        "`cost:cost_margin_insufficient=1439`, `hold:fixture_waiting_for_signal=1439`, `risk:expected_loss_limit_exceeded=1439`, `risk:order_notional_limit_exceeded=1550`",
        "",
      ),
      "utf8",
    );

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("day.blockingReasonCounts is required");
  });

  it("rejects committed evidence day labels with trailing text", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("| Day 1 |", "| Day 1abc |"), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("day.label must match Day N");
  });

  it("counts every committed evidence cost reason in day cost rejected totals", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(
      fixture.evidencePath,
      markdown.replaceAll("cost:cost_margin_insufficient", "cost:spread_too_wide"),
      "utf8",
    );

    const { stdout } = await execFileAsync("node", [scriptPath, "--evidence", fixture.evidencePath, "--document-only", "--json"]);
    const report = JSON.parse(stdout) as CalibrationReportJson;

    expect(report.status).toBe("passed");
    expect(report.days[0]?.metrics.costRejectedCount).toBe(1439);
  });

  it("rejects missing committed evidence count map rows", async () => {
    const fixture = await writeFixtureEvidence({ skipArtifacts: true });
    const markdown = await readFile(fixture.evidencePath, "utf8");
    await writeFile(fixture.evidencePath, markdown.replace("| blockingReasonCounts | `{\"cost:cost_margin_insufficient\":4319,\"hold:fixture_waiting_for_signal\":4319,\"risk:expected_loss_limit_exceeded\":4319,\"risk:order_notional_limit_exceeded\":4378}` |\n", ""), "utf8");

    const result = await runScriptAllowingFailure(["--evidence", fixture.evidencePath, "--document-only", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("table.blockingReasonCounts is required");
  });
});

async function runScriptAllowingFailure(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync("node", [scriptPath, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function writeFixtureEvidence(options: {
  aggregateMetrics?: Partial<CalibrationMetricSummary>;
  dayMetrics?: Array<Partial<CalibrationMetricSummary>>;
  skipArtifacts?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-m11-calibration-"));
  const artifactDir = path.join(root, "trading-soak");
  const prefix = "m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee";
  if (options.skipArtifacts !== true) {
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
          costSummary: createDayCostSummary(day),
          slippageSummary: createSlippageSummary(day === 1 ? 664 : day === 2 ? 668 : 798),
          holdReasonCounts: {
            fixture_waiting_for_signal: day === 1 ? 1439 : 1440,
          },
          blockingReasonCounts: {
            "cost:cost_margin_insufficient": day === 1 ? 1439 : 1440,
            "hold:fixture_waiting_for_signal": day === 1 ? 1439 : 1440,
            "risk:expected_loss_limit_exceeded": day === 1 ? 1439 : 1440,
            "risk:order_notional_limit_exceeded": day === 1 ? 1550 : day === 2 ? 1544 : 1284,
          },
          costRejectedCount: day === 1 ? 1439 : 1440,
          riskRejectedCount: day === 1 ? 2214 : day === 2 ? 2212 : 2082,
          paperOrderSubmittedCount: day === 1 ? 664 : day === 2 ? 668 : 798,
          paperFillCount: day === 1 ? 664 : day === 2 ? 668 : 798,
          ...(options.dayMetrics?.[day - 1] ?? {}),
        }),
      ),
    );
  }
  const evidencePath = path.join(root, "evidence.md");
  await writeFile(evidencePath, createEvidenceMarkdown({ artifactDir, prefix }), "utf8");
  return { root, artifactDir, evidencePath, prefix };
}

function createDayCostSummary(day: number): CalibrationMetricSummary["costSummary"] {
  const evaluatedCount = day === 1 ? 4317 : 4320;
  const rejectedCount = day === 1 ? 1439 : 1440;
  return {
    evaluatedCount,
    allowedCount: evaluatedCount - rejectedCount,
    rejectedCount,
    averageCostBps: "13",
    averageRequiredReturnBps: "23",
    averageMarginBps: "-1.333333333333",
  };
}

function createSlippageSummary(observedFillCount: number): CalibrationMetricSummary["slippageSummary"] {
  return {
    observedFillCount,
    averageSlippageBps: "0",
    minSlippageBps: "0",
    maxSlippageBps: "0",
  };
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
| Day 1 | \`2026-05-25T11:01:10.044Z\` - \`2026-05-26T11:01:10.044Z\` | passed | \`1439\` | \`664 / 664\` | \`1\` | \`4317\` | \`-1.333333333333\` | \`2214\` | \`cost:cost_margin_insufficient=1439\`, \`hold:fixture_waiting_for_signal=1439\`, \`risk:expected_loss_limit_exceeded=1439\`, \`risk:order_notional_limit_exceeded=1550\` |
| Day 2 | \`2026-05-26T11:01:10.044Z\` - \`2026-05-27T11:01:10.044Z\` | passed | \`1440\` | \`668 / 668\` | \`1\` | \`4320\` | \`-1.333333333333\` | \`2212\` | \`cost:cost_margin_insufficient=1440\`, \`hold:fixture_waiting_for_signal=1440\`, \`risk:expected_loss_limit_exceeded=1440\`, \`risk:order_notional_limit_exceeded=1544\` |
| Day 3 | \`2026-05-27T11:01:10.044Z\` - \`2026-05-28T11:01:10.044Z\` | passed | \`1440\` | \`798 / 798\` | \`1\` | \`4320\` | \`-1.333333333333\` | \`2082\` | \`cost:cost_margin_insufficient=1440\`, \`hold:fixture_waiting_for_signal=1440\`, \`risk:expected_loss_limit_exceeded=1440\`, \`risk:order_notional_limit_exceeded=1284\` |

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
  aggregate: { sourceKind: string; metrics: CalibrationMetricSummary };
  days: Array<{ sourceKind: string; metrics: CalibrationMetricSummary }>;
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
