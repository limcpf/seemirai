import { describe, expect, it } from "vitest";
import type { Selectable } from "kysely";
import type { PnLAccountingOutput } from "../../src/application/index.js";
import {
  computePnlSnapshotSourceFingerprint,
  toPnlSnapshotRowInputs,
  toReconcilePositionSnapshotRecord,
} from "../../src/infrastructure/db/index.js";
import type { LiveReconcilePositionSnapshotsTable } from "../../src/infrastructure/db/schema.js";

describe("M17 PnL accounting persistence mapper", () => {
  it("계산 불가 금액을 0으로 꾸며 pnl_snapshots row를 만들지 않는다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        status: "UNAVAILABLE",
        equityKrw: null,
        realizedPnlKrw: null,
        unrealizedPnlKrw: null,
        scopes: [
          {
            strategyId: "trend",
            market: "KRW-BTC",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "unavailable",
            status: "UNAVAILABLE",
          },
        ],
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-unavailable", drawdownBps: "7" },
    );

    expect(rows).toEqual([]);
  });

  it("여러 market scope만 있으면 strategy aggregate row를 새로 만들지 않는다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: "KRW-BTC",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
          {
            strategyId: "trend",
            market: "KRW-ETH",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
        ],
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-aggregate", drawdownBps: "7" },
    );

    expect(rows).toEqual([]);
  });

  it("aggregate scope가 있으면 aggregate row만 저장한다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
          {
            strategyId: "trend",
            market: "KRW-BTC",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
        ],
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-existing-aggregate", drawdownBps: "9" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      strategy_id: "trend",
      market: null,
      drawdown_bps: "9",
    });
  });

  it("단일 market row payload에는 저장 scope의 status를 보존한다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        status: "PARTIAL",
        scopes: [
          {
            strategyId: "trend",
            market: "KRW-BTC",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills" as const,
            status: "CALCULATED" as const,
          },
        ],
        missingReasons: [
          {
            message: "전략 aggregate coverage 부족",
            reasonCode: "SNAPSHOT_COVERAGE_PARTIAL",
            scope: "global",
            source: "pnl_snapshots",
          },
        ],
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-market-scope-status", drawdownBps: "9" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_json).toMatchObject({
      status: "CALCULATED",
      missingReasons: [
        {
          reasonCode: "SNAPSHOT_COVERAGE_PARTIAL",
          scope: "global",
        },
      ],
    });
  });

  it("aggregate row payload에 같은 strategy의 position details를 보존한다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills" as const,
            status: "CALCULATED" as const,
          },
        ],
        positions: [
          {
            strategyId: "trend",
            market: "KRW-BTC",
            quantity: "0.01",
            averageEntryPrice: "100000000",
            marketValueKrw: "1010000",
            unrealizedPnlKrw: "10000",
            exposureBps: "5000",
          },
          {
            strategyId: "mean",
            market: "KRW-ETH",
            quantity: "1",
            averageEntryPrice: "3000000",
            marketValueKrw: "3100000",
            unrealizedPnlKrw: "100000",
            exposureBps: "3000",
          },
        ],
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-position-details", drawdownBps: "9" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload_json).toMatchObject({
      positionDetails: [
        {
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          marketValueKrw: "1010000",
          unrealizedPnlKrw: "10000",
          exposureBps: "5000",
        },
      ],
    });
  });

  it("run id가 없어도 source table trace를 payload에 보존한다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills" as const,
            status: "CALCULATED" as const,
          },
        ],
        trace: {
          sourceTables: ["fills", "positions"],
          lastSourceTimestamp: "2026-06-05T00:00:00.000Z",
        },
      },
      "2026-06-05T00:00:00.000Z",
      { sourceFingerprint: "fp-trace", drawdownBps: "9" },
    );

    expect(rows[0]!.payload_json).toMatchObject({
      trace: {
        sourceTables: ["fills", "positions"],
        lastSourceTimestamp: "2026-06-05T00:00:00.000Z",
      },
    });
  });

  it("여러 strategy aggregate에 global PnL을 복제 저장하지 않는다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
          {
            strategyId: "mean",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
        ],
      },
      "2026-06-05T00:00:00Z",
      { sourceFingerprint: "fp-global-total", drawdownBps: "3" },
    );

    expect(rows).toEqual([]);
  });

  it("aggregate scope가 하나여도 다른 strategy scope가 섞이면 저장하지 않는다", () => {
    const rows = toPnlSnapshotRowInputs(
      {
        ...baseOutput(),
        scopes: [
          {
            strategyId: "trend",
            market: null,
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "fills",
            status: "CALCULATED",
          },
          {
            strategyId: "mean",
            market: "KRW-ETH",
            capturedAt: "2026-06-05T00:00:00.000Z",
            source: "positions",
            status: "CALCULATED",
          },
        ],
      },
      "2026-06-05T00:00:00Z",
      { sourceFingerprint: "fp-mixed-strategy", drawdownBps: "3" },
    );

    expect(rows).toEqual([]);
  });

  it("source fingerprint는 동등한 Date와 timestamp 문자열을 같은 instant로 정규화한다", () => {
    const output = {
      ...baseOutput(),
      scopes: [
        {
          strategyId: "trend",
          market: null,
          capturedAt: "2026-06-05T00:00:00.000Z",
          source: "fills" as const,
          status: "CALCULATED" as const,
        },
      ],
    };

    expect(
      computePnlSnapshotSourceFingerprint(output, new Date("2026-06-05T00:00:00.000Z")),
    ).toBe(computePnlSnapshotSourceFingerprint(output, "2026-06-05T00:00:00Z"));
  });

  it("source fingerprint는 파생 drawdown 값이 바뀌어도 유지된다", () => {
    const output = {
      ...baseOutput(),
      scopes: [
        {
          strategyId: "trend",
          market: null,
          capturedAt: "2026-06-05T00:00:00.000Z",
          source: "fills" as const,
          status: "CALCULATED" as const,
        },
      ],
    };

    expect(computePnlSnapshotSourceFingerprint(output, "2026-06-05T00:00:00Z", "7")).toBe(
      computePnlSnapshotSourceFingerprint(output, "2026-06-05T00:00:00Z", "8"),
    );
  });

  it("source fingerprint는 비용 evidence가 바뀌면 달라진다", () => {
    const base = baseOutput();
    const withFeeEvidence: PnLAccountingOutput = {
      ...base,
      feeTotals: [{ currency: "BTC", amount: "0.00001" }],
    };
    const withQualityEvidence: PnLAccountingOutput = {
      ...base,
      spreadCost: {
        value: "3",
        available: true,
        sampleCount: 1,
        source: "cost_quality_facts",
      },
    };

    expect(
      computePnlSnapshotSourceFingerprint(base, "2026-06-05T00:00:00Z"),
    ).not.toBe(
      computePnlSnapshotSourceFingerprint(withFeeEvidence, "2026-06-05T00:00:00Z"),
    );
    expect(
      computePnlSnapshotSourceFingerprint(base, "2026-06-05T00:00:00Z"),
    ).not.toBe(
      computePnlSnapshotSourceFingerprint(withQualityEvidence, "2026-06-05T00:00:00Z"),
    );
  });

  it("source fingerprint는 포지션 detail evidence가 바뀌면 달라진다", () => {
    const base = baseOutput();
    const withBtcPosition: PnLAccountingOutput = {
      ...base,
      positions: [
        {
          strategyId: "trend",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          marketValueKrw: "1010000",
          unrealizedPnlKrw: "10000",
          exposureBps: "5000",
        },
      ],
    };
    const withChangedPosition: PnLAccountingOutput = {
      ...base,
      positions: [
        {
          strategyId: "trend",
          market: "KRW-BTC",
          quantity: "0.02",
          averageEntryPrice: "50000000",
          marketValueKrw: "1010000",
          unrealizedPnlKrw: "10000",
          exposureBps: "5000",
        },
      ],
    };

    expect(
      computePnlSnapshotSourceFingerprint(withBtcPosition, "2026-06-05T00:00:00Z"),
    ).not.toBe(
      computePnlSnapshotSourceFingerprint(withChangedPosition, "2026-06-05T00:00:00Z"),
    );
  });

  it("live reconcile 조회 row를 calculator 입력 record로 변환한다", () => {
    const capturedAt = new Date("2026-06-05T00:00:00.000Z");
    const row: Selectable<LiveReconcilePositionSnapshotsTable> = {
      id: "00000000-0000-4000-8000-000000000001",
      run_id: "00000000-0000-4000-8000-000000000002",
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategy_id: "trend",
      quantity: "0.01",
      average_entry_price: null,
      recovery_status: "MANUAL_REVIEW_REQUIRED",
      source: "manual_review",
      captured_at: capturedAt,
      evidence_json: { manualReviewEvidenceId: "ev-1" },
      metadata_json: {},
    };

    expect(toReconcilePositionSnapshotRecord(row)).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend",
      quantity: "0.01",
      averageEntryPrice: null,
      recoveryStatus: "MANUAL_REVIEW_REQUIRED",
      source: "manual_review",
      capturedAt,
      evidence: { manualReviewEvidenceId: "ev-1" },
    });
  });
});

function baseOutput(): PnLAccountingOutput {
  return {
    scopes: [],
    status: "CALCULATED",
    realizedPnlKrw: "1200",
    unrealizedPnlKrw: "300",
    totalPnlKrw: "1500",
    cashKrw: "990000",
    positionMarketValueKrw: "10000",
    equityKrw: "1000000",
    positions: [],
    feeTotals: [],
    spreadCost: unavailableMetric(),
    slippage: unavailableMetric(),
    cancelRequote: unavailableMetric(),
    missingReasons: [],
    trace: {
      runId: "run-1",
      sourceTables: ["fills", "positions"],
      lastSourceTimestamp: "2026-06-05T00:00:00.000Z",
    },
  };
}

function unavailableMetric(): PnLAccountingOutput["spreadCost"] {
  return {
    value: null,
    available: false,
    sampleCount: 0,
    source: "unavailable",
  };
}
