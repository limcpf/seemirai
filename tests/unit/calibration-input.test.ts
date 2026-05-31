import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CalibrationMetricSummary } from "../../src/application/calibration.js";
import {
  readCalibrationArtifactSummary,
  readCalibrationEvidenceInput,
  validateCalibrationEvidenceInput,
} from "../../src/application/calibration.js";

describe("M11 calibration input reader", () => {
  it("reads the committed #68 internal evidence document as the primary calibration input", async () => {
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
    expect(validation).toMatchObject({ passed: true, failures: [] });
  });

  it("can replace document table values with source artifact summaries when requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "seemirai-calibration-input-"));
    const artifactDir = path.join(root, "trading-soak");
    await mkdir(artifactDir);
    const prefix = "m9-paper-trading-soak-2026-05-31T00-00-00-000Z-10210210";
    await writeSummary(path.join(artifactDir, `${prefix}-summary.json`), null, { paperOrderSubmittedCount: 9 });
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
    expect(input.aggregate.metrics.paperOrderSubmittedCount).toBe(9);
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
    blockingReasonCounts: { "cost:cost_margin_insufficient": 1 },
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
