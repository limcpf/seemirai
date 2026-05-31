import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CalibrationMetricSummary } from "../../src/application/calibration.js";
import {
  analyzeCalibrationPolicy,
  readCalibrationArtifactSummary,
  readCalibrationEvidenceInput,
  validateCalibrationEvidenceInput,
} from "../../src/application/calibration.js";

describe("M11 calibration input reader", () => {
  it("reads the committed #68 internal evidence document and fails closed on day metrics that require source artifacts", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput(input);

    expect(input.runPrefix).toBe("m9-paper-trading-soak-2026-05-25T11-01-04-344Z-e398a8ee");
    expect(input.aggregate.metrics.paperOrderSubmittedCount).toBe(2130);
    expect(input.aggregate.metrics.paperFillCount).toBe(2130);
    expect(input.aggregate.metrics.liveOrderApiCalls).toBe(0);
    expect(input.aggregate.metrics.costSummary.averageMarginBps).toBe("-1.333333333333");
    expect(input.days).toHaveLength(3);
    expect(input.days[0]?.metrics.blockingReasonCounts["risk:expected_loss_limit_exceeded"]).toBe(1439);
    expect(input.days[0]?.metrics.costSummary.averageCostBps).toBeNull();
    expect(validation.passed).toBe(false);
    expect(validation.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldPath: "days[0].metrics.costSummary.averageCostBps" }),
        expect.objectContaining({ fieldPath: "days[0].metrics.slippageSummary.averageSlippageBps" }),
      ]),
    );
  });

  it("can replace document table values with source artifact summaries when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-input-"));
    const artifactDir = path.join(root, "trading-soak");
    await mkdir(artifactDir);
    const prefix = "m9-paper-trading-soak-2026-05-31T00-00-00-000Z-10210210";
    await writeSummary(path.join(artifactDir, `${prefix}-summary.json`), null, {
      costSummary: {
        evaluatedCount: 9,
        allowedCount: 6,
        rejectedCount: 3,
        averageCostBps: "13",
        averageRequiredReturnBps: "23",
        averageMarginBps: "-1.333333333333",
      },
      slippageSummary: {
        observedFillCount: 3,
        averageSlippageBps: "0",
        minSlippageBps: "0",
        maxSlippageBps: "0",
      },
      holdReasonCounts: { fixture_waiting_for_signal: 3 },
      blockingReasonCounts: { "cost:cost_margin_insufficient": 3, "risk:expected_loss_limit_exceeded": 3 },
      costRejectedCount: 3,
      riskRejectedCount: 3,
      paperOrderSubmittedCount: 6,
      paperFillCount: 6,
    });
    await Promise.all(
      [1, 2, 3].map((day) =>
        writeSummary(path.join(artifactDir, `${prefix}-day-${day}-summary.json`), day, {
          paperOrderSubmittedCount: day,
          paperFillCount: day,
        }),
      ),
    );
    const evidencePath = path.join(root, "evidence.md");
    await writeFile(evidencePath, createEvidenceMarkdown({ artifactDir, prefix }), "utf8");

    const input = await readCalibrationEvidenceInput({ evidencePath, readSourceArtifacts: true });
    const validation = validateCalibrationEvidenceInput(input);

    expect(input.aggregate.sourceKind).toBe("artifact_summary");
    expect(input.aggregate.metrics.paperOrderSubmittedCount).toBe(6);
    expect(input.days.map((day) => day.metrics.paperOrderSubmittedCount)).toEqual([1, 2, 3]);
    expect(validation.passed).toBe(true);
  });

  it("fails closed when a required metric is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-missing-"));
    const summaryPath = path.join(root, "summary.json");
    const summary = createSummary(null, {});
    delete (summary.metrics as unknown as Record<string, unknown>).blockingReasonCounts;
    await writeFile(summaryPath, JSON.stringify(summary), "utf8");

    await expect(readCalibrationArtifactSummary({ summaryPath })).rejects.toThrow();
  });

  it("rejects source artifact day content that disagrees with the expected day", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-day-mismatch-"));
    const summaryPath = path.join(root, "day-2-summary.json");
    await writeFile(summaryPath, JSON.stringify(createSummary(1, {})), "utf8");

    await expect(readCalibrationArtifactSummary({ summaryPath, day: 2 })).rejects.toThrow("day must match expected Day 2");
  });

  it("rejects committed evidence day labels with trailing text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-day-label-"));
    const artifactDir = path.join(root, "artifacts");
    const evidencePath = path.join(root, "evidence.md");
    await writeFile(evidencePath, createEvidenceMarkdown({ artifactDir, prefix: "m9-paper-trading-soak-fixture" }).replace("| Day 1 |", "| Day 1abc |"), "utf8");

    await expect(readCalibrationEvidenceInput({ evidencePath })).rejects.toThrow("day.label must match Day N");
  });

  it("rejects committed evidence submitted/fill cells with trailing text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-submitted-fill-"));
    const artifactDir = path.join(root, "artifacts");
    const evidencePath = path.join(root, "evidence.md");
    await writeFile(
      evidencePath,
      createEvidenceMarkdown({ artifactDir, prefix: "m9-paper-trading-soak-fixture" }).replace("`1 / 1`", "`1abc / 1`"),
      "utf8",
    );

    await expect(readCalibrationEvidenceInput({ evidencePath })).rejects.toThrow("day.paperOrderSubmittedCount must be a safe integer");
  });

  it("rejects calibration input when live order API calls are present", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          liveOrderApiCalls: 1,
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.liveOrderApiCalls",
      }),
    );
  });

  it("rejects non-number count values in prebuilt calibration input objects", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          paperOrderSubmittedCount: "2130" as unknown as number,
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.paperOrderSubmittedCount",
        message: "count metric은 0 이상의 안전한 정수여야 합니다.",
      }),
    );
  });

  it("rejects invalid fill rate and missing margin in prebuilt calibration input objects", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          fillRate: 2,
          costSummary: {
            ...input.aggregate.metrics.costSummary,
            averageMarginBps: null,
          },
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "aggregate.metrics.fillRate",
          message: "fillRate는 0 이상 1 이하의 유한한 숫자여야 합니다.",
        }),
        expect.objectContaining({
          fieldPath: "aggregate.metrics.costSummary.averageMarginBps",
          message: "비용 평가가 있는 summary에는 평균 margin bps가 있어야 합니다.",
        }),
      ]),
    );
  });

  it("rejects fill rate values that do not match paper order and fill counts", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          fillRate: 0.5,
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.fillRate",
        message: "fillRate는 paper 주문/체결 count와 일치해야 합니다.",
      }),
    );
  });

  it("accepts fill rate rounded to the runner precision", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          paperOrderSubmittedCount: 3,
          paperFillCount: 1,
          fillRate: 0.333333,
        },
      },
    });

    expect(validation.failures).not.toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.fillRate",
      }),
    );
  });

  it("rejects malformed decimal strings and missing reason count maps in prebuilt inputs", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costSummary: {
            ...input.aggregate.metrics.costSummary,
            averageMarginBps: "abc",
          },
          holdReasonCounts: null as unknown as Record<string, number>,
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldPath: "aggregate.metrics.costSummary.averageMarginBps",
          message: "decimal metric은 유한한 숫자 문자열이어야 합니다.",
        }),
        expect.objectContaining({
          fieldPath: "aggregate.metrics.holdReasonCounts",
          message: "reason count map은 객체여야 합니다.",
        }),
      ]),
    );
  });

  it("rejects malformed decimal strings even when cost evaluation count is zero", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costSummary: {
            ...input.aggregate.metrics.costSummary,
            evaluatedCount: 0,
            allowedCount: 0,
            rejectedCount: 0,
            averageMarginBps: "abc",
          },
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary.averageMarginBps",
        message: "decimal metric은 유한한 숫자 문자열이어야 합니다.",
      }),
    );
  });

  it("rejects inconsistent cost summary count totals", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costSummary: {
            ...input.aggregate.metrics.costSummary,
            evaluatedCount: 3,
            allowedCount: 3,
            rejectedCount: 3,
          },
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary",
        message: "비용 허용/차단 count 합계는 평가 count와 일치해야 합니다.",
      }),
    );
  });

  it("returns failures for missing nested summary objects instead of throwing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costSummary: null as unknown as CalibrationMetricSummary["costSummary"],
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costSummary",
        message: "cost summary는 객체여야 합니다.",
      }),
    );
  });

  it("returns failures for missing metrics objects instead of throwing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: null as unknown as CalibrationMetricSummary,
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics",
        message: "summary metrics는 객체여야 합니다.",
      }),
    );
  });

  it("returns failures for missing top-level day lists instead of throwing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      days: null as unknown as typeof input.days,
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "days",
        message: "Day summary 목록은 배열이어야 합니다.",
      }),
    );
  });

  it("returns failures for missing top-level aggregate instead of throwing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: null as unknown as typeof input.aggregate,
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate",
        message: "summary는 객체여야 합니다.",
      }),
    );
  });

  it("returns failures for invalid day entries instead of throwing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      days: [input.days[0]!, null, input.days[2]!] as unknown as typeof input.days,
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "days[1]",
        message: "Day summary는 객체여야 합니다.",
      }),
    );
  });

  it("rejects aggregate metrics that do not match day totals", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          paperOrderSubmittedCount: input.aggregate.metrics.paperOrderSubmittedCount + 1,
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.paperOrderSubmittedCount",
        message: "aggregate metric은 Day 1/2/3 합계와 일치해야 합니다.",
      }),
    );
  });

  it("returns failed policy analysis when invalid metrics remove cost summary", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const analysis = analyzeCalibrationPolicy({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costSummary: null as unknown as CalibrationMetricSummary["costSummary"],
        },
      },
    });

    expect(analysis.status).toBe("failed");
    expect(analysis.averageMarginBps).toBeNull();
  });

  it("rejects cost reason count totals that do not match cost reject count", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      aggregate: {
        ...input.aggregate,
        metrics: {
          ...input.aggregate.metrics,
          costRejectedCount: 2,
          blockingReasonCounts: {
            ...input.aggregate.metrics.blockingReasonCounts,
            "cost:cost_margin_insufficient": 1,
          },
        },
      },
    });

    expect(validation.passed).toBe(false);
    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "aggregate.metrics.costRejectedCount",
        message: "비용 reject count는 cost reason 합계와 일치해야 합니다.",
      }),
    );
  });

  it("fails closed when day numbers are duplicated or missing", async () => {
    const input = await readCalibrationEvidenceInput({
      evidencePath: "docs/references/m9-paper-trading-soak-2026-05-25-e398a8ee.md",
    });
    const validation = validateCalibrationEvidenceInput({
      ...input,
      days: [
        input.days[0]!,
        {
          ...input.days[1]!,
          day: 2,
        },
        {
          ...input.days[2]!,
          day: 2,
        },
      ],
    });

    expect(validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "days",
        message: "Day summary 번호는 정확히 Day 1/2/3을 한 번씩 포함해야 합니다.",
      }),
    );
  });

  it("does not coerce empty numeric markdown cells to zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-empty-number-"));
    const artifactDir = path.join(root, "trading-soak");
    const prefix = "m9-paper-trading-soak-2026-05-31T00-00-00-000Z-10210211";
    const evidencePath = path.join(root, "evidence.md");
    await mkdir(artifactDir);
    await writeFile(
      evidencePath,
      createEvidenceMarkdown({ artifactDir, prefix }).replace("| liveOrderApiCalls | `0` |", "| liveOrderApiCalls |  |"),
      "utf8",
    );

    await expect(readCalibrationEvidenceInput({ evidencePath })).rejects.toThrow("table.liveOrderApiCalls is required");
  });

  it("rejects exported reader integer cells with trailing text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-reader-integer-"));
    const artifactDir = path.join(root, "trading-soak");
    const prefix = "m9-paper-trading-soak-2026-05-31T00-00-00-000Z-10210212";
    const evidencePath = path.join(root, "evidence.md");
    await mkdir(artifactDir);
    await writeFile(
      evidencePath,
      createEvidenceMarkdown({ artifactDir, prefix }).replace("| Day 1 |", "| Day 1 |").replace("`3` | `-1.333333333333` |", "`3abc` | `-1.333333333333` |"),
      "utf8",
    );

    await expect(readCalibrationEvidenceInput({ evidencePath })).rejects.toThrow("day.costSummary.evaluatedCount must be a safe integer");
  });
});

async function writeSummary(summaryPath: string, day: number | null, overrides: Partial<CalibrationMetricSummary>) {
  await writeFile(
    summaryPath,
    JSON.stringify(
      {
        status: "passed",
        input: "upbit_public_websocket_paper_trading_loop",
        startedAt: "2026-05-31T00:00:00.000Z",
        finishedAt: "2026-05-31T01:00:00.000Z",
        day,
        metrics: createMetrics(overrides),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function createSummary(day: number | null, metricOverrides: Partial<CalibrationMetricSummary>) {
  return {
    status: "passed",
    day,
    metrics: createMetrics(metricOverrides),
  };
}

function createMetrics(overrides: Partial<CalibrationMetricSummary> = {}): CalibrationMetricSummary {
  return {
    costSummary: {
      evaluatedCount: 3,
      allowedCount: 2,
      rejectedCount: 1,
      averageCostBps: "13",
      averageRequiredReturnBps: "23",
      averageMarginBps: "-1.333333333333",
    },
    slippageSummary: {
      observedFillCount: 1,
      averageSlippageBps: "0",
      minSlippageBps: "0",
      maxSlippageBps: "0",
    },
    holdReasonCounts: { fixture_waiting_for_signal: 1 },
    discardReasonCounts: {},
    blockingReasonCounts: { "cost:cost_margin_insufficient": 1, "risk:expected_loss_limit_exceeded": 1 },
    costRejectedCount: 1,
    riskRejectedCount: 1,
    paperOrderSubmittedCount: 1,
    paperFillCount: 1,
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
| startedAt | \`2026-05-31T00:00:00.000Z\` |
| finishedAt | \`2026-05-31T01:00:00.000Z\` |
| paperOrderSubmittedCount | \`1\` |
| paperFillCount | \`1\` |
| fillRate | \`1\` |
| liveOrderApiCalls | \`0\` |

## Cost, slippage, and blocking

| 항목 | 값 |
| --- | --- |
| costSummary.evaluatedCount | \`3\` |
| costSummary.allowedCount | \`2\` |
| costSummary.rejectedCount | \`1\` |
| averageCostBps | \`13\` |
| averageRequiredReturnBps | \`23\` |
| averageMarginBps | \`-1.333333333333\` |
| slippageSummary.observedFillCount | \`1\` |
| averageSlippageBps | \`0\` |
| holdReasonCounts | \`{"fixture_waiting_for_signal":1}\` |
| discardReasonCounts | \`{}\` |
| costRejectedCount | \`1\` |
| riskRejectedCount | \`1\` |
| blockingReasonCounts | \`{"cost:cost_margin_insufficient":1}\` |

## Day comparison

| 일차 | 기간 | status | cycles | submitted/fill | fillRate | cost evaluated | averageMarginBps | riskRejectedCount | 주요 차단 사유 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Day 1 | \`2026-05-31T00:00:00.000Z\` - \`2026-05-31T01:00:00.000Z\` | passed | \`1\` | \`1 / 1\` | \`1\` | \`3\` | \`-1.333333333333\` | \`1\` | \`cost:cost_margin_insufficient=1\` |
| Day 2 | \`2026-05-31T01:00:00.000Z\` - \`2026-05-31T02:00:00.000Z\` | passed | \`1\` | \`1 / 1\` | \`1\` | \`3\` | \`-1.333333333333\` | \`1\` | \`cost:cost_margin_insufficient=1\` |
| Day 3 | \`2026-05-31T02:00:00.000Z\` - \`2026-05-31T03:00:00.000Z\` | passed | \`1\` | \`1 / 1\` | \`1\` | \`3\` | \`-1.333333333333\` | \`1\` | \`cost:cost_margin_insufficient=1\` |

## Validation command

\`\`\`sh
node scripts/validate-m9-paper-soak-evidence.mjs --artifact-dir ${input.artifactDir} --issue-comment
\`\`\`
`;
}
