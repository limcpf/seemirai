import { describe, expect, it } from "vitest";

import type { CalibrationEvidenceInput, CalibrationMetricSummary } from "../../src/application/calibration.js";
import { analyzeCalibrationPolicy, splitCalibrationReasonCounts } from "../../src/application/calibration.js";

describe("M11 calibration policy", () => {
  it("splits blocking reasons into cost, risk, hold, discard, and unknown axes", () => {
    const breakdown = splitCalibrationReasonCounts(
      createMetrics({
        holdReasonCounts: { fixture_waiting_for_signal: 10 },
        discardReasonCounts: { paper_broker_rejected: 2 },
        blockingReasonCounts: {
          "cost:cost_margin_insufficient": 4,
          "discard:paper_broker_rejected": 2,
          "hold:fixture_waiting_for_signal": 10,
          "risk:expected_loss_limit_exceeded": 3,
          "risk:order_notional_limit_exceeded": 5,
          legacy_without_axis: 7,
        },
      }),
    );

    expect(breakdown.cost).toEqual({
      counts: { cost_margin_insufficient: 4 },
      totalCount: 4,
    });
    expect(breakdown.risk).toEqual({
      counts: {
        expected_loss_limit_exceeded: 3,
        order_notional_limit_exceeded: 5,
      },
      totalCount: 8,
    });
    expect(breakdown.hold.counts).toEqual({ fixture_waiting_for_signal: 10 });
    expect(breakdown.discard.counts).toEqual({ paper_broker_rejected: 2 });
    expect(breakdown.unknown.counts).toEqual({ legacy_without_axis: 7 });
    expect(breakdown.totals).toEqual({
      blockingCount: 31,
      explicitDiscardCount: 2,
      explicitHoldCount: 10,
    });
  });

  it("blocks aggressive threshold relaxation when aggregate margin is negative", () => {
    const analysis = analyzeCalibrationPolicy(createEvidenceInput());

    expect(analysis.status).toBe("ok");
    expect(analysis.thresholdRelaxationBlocked).toBe(true);
    expect(analysis.averageMarginBps).toBe("-1.333333333333");
    expect(analysis.operatorSummary).toContain("threshold 완화 후보는 기본 제안으로 승격하지 않습니다");
    expect(analysis.aggregateReasonBreakdown?.risk.totalCount).toBe(8697);
    expect(analysis.dayReasonBreakdowns.map((day) => day.day)).toEqual([1, 2, 3]);

    const relaxation = analysis.candidates.find((candidate) => candidate.key === "relax_alpha_thresholds");
    expect(relaxation).toMatchObject({
      aggressiveness: "aggressive",
      direction: "decrease_requires_approval",
      status: "blocked",
    });
    expect(analysis.candidates.filter((candidate) => candidate.status === "recommended")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "cost_safety_buffer_bps", aggressiveness: "conservative", direction: "increase_or_keep" }),
        expect.objectContaining({ key: "min_volume_spike_ratio", aggressiveness: "conservative", direction: "increase_or_keep" }),
        expect.objectContaining({ key: "min_session_liquidity_score", aggressiveness: "conservative", direction: "increase_or_keep" }),
        expect.objectContaining({ key: "max_spread_bps", aggressiveness: "conservative", direction: "decrease_or_keep" }),
        expect.objectContaining({ key: "min_cost_adjusted_margin_bps", aggressiveness: "conservative", direction: "increase_or_keep" }),
      ]),
    );
  });

  it("separates order notional and expected loss risk interactions from strategy thresholds", () => {
    const analysis = analyzeCalibrationPolicy(createEvidenceInput());

    expect(analysis.riskInteractions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "expected_loss_limit_review",
          reasonCode: "expected_loss_limit_exceeded",
          count: 4319,
        }),
        expect.objectContaining({
          kind: "order_notional_limit_review",
          reasonCode: "order_notional_limit_exceeded",
          count: 4378,
        }),
      ]),
    );
    expect(analysis.riskInteractions.every((interaction) => interaction.action.includes("threshold") || interaction.action.includes("주문"))).toBe(
      true,
    );
  });

  it("does not create candidates when calibration input validation fails", () => {
    const analysis = analyzeCalibrationPolicy(
      createEvidenceInput({
        aggregateMetrics: {
          liveOrderApiCalls: 1,
        },
      }),
    );

    expect(analysis.status).toBe("failed");
    expect(analysis.thresholdRelaxationBlocked).toBe(true);
    expect(analysis.candidates).toEqual([]);
    expect(analysis.riskInteractions).toEqual([]);
    expect(analysis.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.liveOrderApiCalls",
      }),
    );
  });

  it("returns failed analysis when aggregate is missing", () => {
    const analysis = analyzeCalibrationPolicy({
      ...createEvidenceInput(),
      aggregate: null as unknown as CalibrationEvidenceInput["aggregate"],
    });

    expect(analysis.status).toBe("failed");
    expect(analysis.averageMarginBps).toBeNull();
    expect(analysis.candidates).toEqual([]);
    expect(analysis.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate",
      }),
    );
  });

  it("returns failed analysis when top-level input is invalid", () => {
    const analysis = analyzeCalibrationPolicy(null as unknown as CalibrationEvidenceInput);

    expect(analysis.status).toBe("failed");
    expect(analysis.averageMarginBps).toBeNull();
    expect(analysis.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "input",
      }),
    );
  });
});

function createEvidenceInput(options: { aggregateMetrics?: Partial<CalibrationMetricSummary> } = {}): CalibrationEvidenceInput {
  const aggregateMetrics = createMetrics({
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

  return {
    evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    targetIssue: "#68",
    runPrefix: "m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee",
    status: "passed",
    sourceArtifacts: {
      aggregateReportPath: "/vault/aggregate-report.md",
      aggregateSummaryPath: "/vault/aggregate-summary.json",
      comparisonReportPath: "/vault/comparison.md",
      dayReportPaths: [1, 2, 3].map((day) => ({ day, path: `/vault/day-${day}-report.md` })),
      daySummaryPaths: [1, 2, 3].map((day) => ({ day, path: `/vault/day-${day}-summary.json` })),
      rawEventLogPath: "/vault/events.jsonl",
    },
    validationCommand: "node scripts/validate-m9-paper-soak-evidence.mjs --issue-comment",
    aggregate: {
      sourceKind: "artifact_summary",
      sourcePath: "/vault/aggregate-summary.json",
      day: null,
      status: "passed",
      startedAt: "2026-05-25T11:01:10.044Z",
      finishedAt: "2026-05-28T11:01:10.055Z",
      metrics: aggregateMetrics,
    },
    days: [
      { day: 1, costEvaluatedCount: 4317, paperCount: 664, riskRejectedCount: 2214, orderNotionalCount: 1550 },
      { day: 2, costEvaluatedCount: 4320, paperCount: 668, riskRejectedCount: 2212, orderNotionalCount: 1544 },
      { day: 3, costEvaluatedCount: 4320, paperCount: 798, riskRejectedCount: 2082, orderNotionalCount: 1284 },
    ].map(({ day, costEvaluatedCount, paperCount, riskRejectedCount, orderNotionalCount }) => ({
      sourceKind: "artifact_summary",
      sourcePath: `/vault/day-${day}-summary.json`,
      day,
      status: "passed",
      startedAt: `2026-05-2${day + 4}T11:01:10.044Z`,
      finishedAt: `2026-05-2${day + 5}T11:01:10.044Z`,
      metrics: createMetrics({
        costSummary: {
          evaluatedCount: costEvaluatedCount,
          allowedCount: costEvaluatedCount - 1440 + (day === 1 ? 1 : 0),
          rejectedCount: 1440 - (day === 1 ? 1 : 0),
          averageCostBps: "13",
          averageRequiredReturnBps: "23",
          averageMarginBps: "-1.333333333333",
        },
        slippageSummary: {
          observedFillCount: paperCount,
          averageSlippageBps: "0",
          minSlippageBps: "0",
          maxSlippageBps: "0",
        },
        holdReasonCounts: {
          fixture_waiting_for_signal: 1440 - (day === 1 ? 1 : 0),
        },
        blockingReasonCounts: {
          "cost:cost_margin_insufficient": 1440 - (day === 1 ? 1 : 0),
          "hold:fixture_waiting_for_signal": 1440 - (day === 1 ? 1 : 0),
          "risk:expected_loss_limit_exceeded": 1440 - (day === 1 ? 1 : 0),
          "risk:order_notional_limit_exceeded": orderNotionalCount,
        },
        costRejectedCount: 1440 - (day === 1 ? 1 : 0),
        riskRejectedCount,
        paperOrderSubmittedCount: paperCount,
        paperFillCount: paperCount,
      }),
    })),
  };
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
