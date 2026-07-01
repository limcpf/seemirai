import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it } from "vitest";

const modulePath = path.join(process.cwd(), "scripts/analyze-live-decision-calibration.mjs");

describe("live decision calibration report", () => {
  it("summarizes threshold quality, feature quality, candidates, and realized outcomes", async () => {
    const {
      createLiveDecisionCalibrationReport,
      renderLiveDecisionCalibrationMarkdown,
    } = await import(modulePath);

    const report = createLiveDecisionCalibrationReport({
      generatedAt: "2026-06-30T00:00:00.000Z",
      source: {
        kind: "fixture",
        label: "unit-live-decisions",
      },
      ticks: [
        createTick({
          decisionKind: "HOLD",
          featureSource: "live_ops_db_window",
          features: {
            cost_adjusted_margin_bps: "8",
            mean_reversion_discount_bps: "30",
            trend_strength_bps: "0",
          },
          orderIntentCount: 0,
          reasonCode: "autonomous_24x7_entry_signal_weak",
        }),
        createTick({
          decisionKind: "BLOCK",
          featureSnapshot: {
            status: "failed",
            features: {},
            failureReasons: [
              {
                reasonCode: "FEATURE_MARKET_DATA_STALE",
                key: "cost_adjusted_margin_bps",
              },
            ],
            metadata: {
              source: "live_ops_db_window",
            },
          },
          orderIntentCount: 0,
          reasonCode: "autonomous_24x7_feature_snapshot_failed",
        }),
        createTick({
          decisionKind: "BUY",
          featureSource: "live_ops_cli_public_tick_edge",
          features: {
            cost_adjusted_margin_bps: "25",
            mean_reversion_discount_bps: "35",
            trend_strength_bps: "0",
          },
          orderIntentCount: 1,
          reasonCode: "autonomous_24x7_entry_signal",
        }),
      ],
      outcomes: {
        fills: [{ id: "fill-1", order_id: "order-1" }],
        orders: [{ id: "order-1", status: "FILLED" }],
      },
      window: {
        market: "KRW-BTC",
        strategyId: "live_ops_autonomous_24x7_core",
        windowEndAt: "2026-06-30T00:10:00.000Z",
        windowStartAt: "2026-06-30T00:00:00.000Z",
      },
    });
    const markdown = renderLiveDecisionCalibrationMarkdown(report);

    expect(report.status).toBe("passed");
    expect(report.decisionCounts).toMatchObject({
      BLOCK: 1,
      BUY: 1,
      HOLD: 1,
    });
    expect(report.featureQuality).toMatchObject({
      failureReasonCounts: {
        FEATURE_MARKET_DATA_STALE: 1,
      },
      sourceCounts: {
        live_ops_cli_public_tick_edge: 1,
        live_ops_db_window: 2,
      },
      statusCounts: {
        failed: 1,
        ok: 2,
      },
    });
    expect(report.thresholdQuality.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKey: "cost_adjusted_margin_bps",
          passCount: 1,
          thresholdKey: "min_entry_margin_bps",
          totalCount: 2,
        }),
        expect.objectContaining({
          featureKey: "mean_reversion_discount_bps",
          passCount: 2,
          thresholdKey: "mean_reversion_discount_bps",
          totalCount: 2,
        }),
      ]),
    );
    expect(report.candidateOutcome).toMatchObject({
      fillCount: 1,
      filledOrderCount: 1,
      orderCount: 1,
      realizedFillRate: 1,
      totalOrderIntentCount: 1,
    });
    expect(markdown).toContain("## Threshold 품질");
    expect(markdown).toContain("## 후보/실현 결과");
    expect(markdown).toContain("추적 정보");
  });

  it("includes flat feature snapshots in threshold quality", async () => {
    const {
      createLiveDecisionCalibrationReport,
    } = await import(modulePath);

    const report = createLiveDecisionCalibrationReport({
      generatedAt: "2026-06-30T00:00:00.000Z",
      source: {
        kind: "fixture",
        label: "flat-feature-snapshot",
      },
      ticks: [
        createTick({
          decisionKind: "HOLD",
          featureSnapshot: {
            status: "ok",
            cost_adjusted_margin_bps: "21",
            feature_source: "live_ops_decision_details",
            mean_reversion_discount_bps: "31",
            trend_strength_bps: "11",
          },
          orderIntentCount: 0,
          reasonCode: "autonomous_24x7_entry_signal_weak",
        }),
      ],
      window: {
        market: "KRW-BTC",
        strategyId: "live_ops_autonomous_24x7_core",
        windowEndAt: "2026-06-30T00:10:00.000Z",
        windowStartAt: "2026-06-30T00:00:00.000Z",
      },
    });

    expect(report.featureQuality).toMatchObject({
      sourceCounts: {
        live_ops_decision_details: 1,
      },
      statusCounts: {
        ok: 1,
      },
    });
    expect(report.thresholdQuality.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKey: "cost_adjusted_margin_bps",
          missingCount: 0,
          passCount: 1,
          totalCount: 1,
        }),
        expect.objectContaining({
          featureKey: "trend_strength_bps",
          missingCount: 0,
          passCount: 1,
          totalCount: 1,
        }),
      ]),
    );
  });

  it("calculates realized fill rate by unique filled order ids", async () => {
    const {
      createLiveDecisionCalibrationReport,
    } = await import(modulePath);

    const report = createLiveDecisionCalibrationReport({
      generatedAt: "2026-06-30T00:00:00.000Z",
      source: {
        kind: "fixture",
        label: "partial-fills",
      },
      ticks: [
        createTick({
          decisionKind: "BUY",
          featureSource: "live_ops_db_window",
          features: {
            cost_adjusted_margin_bps: "25",
            mean_reversion_discount_bps: "35",
            trend_strength_bps: "12",
          },
          orderIntentCount: 1,
          reasonCode: "autonomous_24x7_entry_signal",
        }),
      ],
      outcomes: {
        fills: [
          { id: "fill-1", order_id: "order-1" },
          { id: "fill-2", order_id: "order-1" },
        ],
        orders: [
          { id: "order-1", status: "PARTIAL_FILL" },
          { id: "order-2", status: "CANCELED" },
        ],
      },
      window: {
        market: "KRW-BTC",
        strategyId: "live_ops_autonomous_24x7_core",
        windowEndAt: "2026-06-30T00:10:00.000Z",
        windowStartAt: "2026-06-30T00:00:00.000Z",
      },
    });

    expect(report.candidateOutcome).toMatchObject({
      fillCount: 2,
      filledOrderCount: 1,
      orderCount: 2,
      realizedFillRate: 0.5,
    });
  });

  it("fails closed when no decision ticks are available", async () => {
    const {
      createLiveDecisionCalibrationReport,
      renderLiveDecisionCalibrationMarkdown,
    } = await import(modulePath);

    const report = createLiveDecisionCalibrationReport({
      generatedAt: "2026-06-30T00:00:00.000Z",
      source: {
        kind: "fixture",
        label: "empty",
      },
      ticks: [],
      window: {
        market: "KRW-BTC",
        strategyId: "live_ops_autonomous_24x7_core",
        windowEndAt: "2026-06-30T00:10:00.000Z",
        windowStartAt: "2026-06-30T00:00:00.000Z",
      },
    });

    expect(report.status).toBe("failed");
    expect(report.validation.failures).toContainEqual(
      expect.objectContaining({
        fieldPath: "ticks",
      }),
    );
    expect(renderLiveDecisionCalibrationMarkdown(report)).toContain("판정: 실패");
  });

  it("writes a reproducible Markdown artifact from the CLI", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-decision-calibration-"));
    const inputPath = path.join(tempDir, "ticks.json");
    const outputPath = path.join(tempDir, "report.md");
    const envPath = path.join(tempDir, "live-ops.env");
    await writeFile(envPath, "SEEMIRAI_DATABASE_URL=postgres://localhost/seemirai\n", "utf8");
    await writeFile(
      inputPath,
      JSON.stringify({
        ticks: [
          createTick({
            decisionKind: "BUY",
            featureSource: "live_ops_db_window",
            features: {
              cost_adjusted_margin_bps: "25",
              mean_reversion_discount_bps: "35",
              trend_strength_bps: "12",
            },
            orderIntentCount: 1,
            reasonCode: "autonomous_24x7_entry_signal",
          }),
        ],
        window: {
          market: "KRW-BTC",
          strategyId: "live_ops_autonomous_24x7_core",
          windowEndAt: "2026-06-30T00:10:00.000Z",
          windowStartAt: "2026-06-30T00:00:00.000Z",
        },
      }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/analyze-live-decision-calibration.mjs", "--input", inputPath, "--env-file", envPath, "--output", outputPath, "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const stdout = JSON.parse(result.stdout) as Record<string, any>;
    const markdown = await readFile(outputPath, "utf8");
    expect(stdout).toMatchObject({
      status: "passed",
      tickCount: 1,
    });
    expect(markdown).toContain("## Threshold 품질");
    expect(markdown).toContain("## 후보/실현 결과");
  });

  it("rejects database URL as a CLI argument", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/analyze-live-decision-calibration.mjs", "--database-url", "postgres://localhost/seemirai", "--window-start", "2026-06-30T00:00:00.000Z", "--window-end", "2026-06-30T00:10:00.000Z"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--database-url은 보안상 지원하지 않습니다");
  });
});

function createTick(input: {
  decisionKind: "BLOCK" | "BUY" | "HOLD" | "SELL";
  featureSnapshot?: Record<string, unknown>;
  featureSource?: string;
  features?: Record<string, string>;
  orderIntentCount: number;
  reasonCode: string;
}): Record<string, unknown> {
  return {
    decision_kind: input.decisionKind,
    feature_snapshot_json: input.featureSnapshot ?? {
      status: "ok",
      features: input.features ?? {},
      failureReasons: [],
      metadata: {
        source: input.featureSource,
      },
    },
    market: "KRW-BTC",
    observed_at: "2026-06-30T00:01:00.000Z",
    order_intent_count: input.orderIntentCount,
    reason_code: input.reasonCode,
    strategy_id: "live_ops_autonomous_24x7_core",
    threshold_json: {
      strategyThresholds: {
        mean_reversion_discount_bps: "30",
        min_entry_margin_bps: "20",
        trend_confirmation_bps: "10",
      },
    },
  };
}
