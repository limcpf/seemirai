import { describe, expect, it } from "vitest";
import type {
  PnLAccountingInput,
  PnLSnapshotFact,
} from "../../src/application/index.js";
import {
  runPnLAccountingCloseout,
} from "../../src/application/index.js";
import type {
  PnLAccountingDataProvider,
  PnLAccountingSnapshotPersistencePort,
  PnLAccountingSnapshotPersistenceResult,
  PersistPnLAccountingSnapshotInput,
} from "../../src/application/index.js";
import type {
  PnlSnapshotRecord,
} from "../../src/infrastructure/db/index.js";
import {
  createDatabasePnLAccountingStatusProvider,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

// ── fixture data provider ────────────────────────────────────────────────────

function createFixtureDataProvider(
  input: PnLAccountingInput,
  drawdownHistory: readonly PnLSnapshotFact[] = [],
): PnLAccountingDataProvider {
  return {
    async loadPnLAccountingInput(): Promise<PnLAccountingInput> {
      return input;
    },
    async loadPnLAccountingSnapshotHistory(): Promise<readonly PnLSnapshotFact[]> {
      return drawdownHistory;
    },
  };
}

function fixtureInput(): PnLAccountingInput {
  return {
    fills: [
      {
        orderId: "o1",
        strategyId: "trend",
        market: "KRW-BTC",
        side: "BUY",
        price: "100000000",
        quantity: "0.01",
        fee: "50",
        feeCurrency: "KRW",
        liquidity: "TAKER",
        filledAt: new Date("2026-06-01T00:00:00Z"),
      },
    ],
    positions: [],
    markPrices: [
      {
        market: "KRW-BTC",
        priceKrw: "101000000",
        source: "fixture_bid",
        observedAt: new Date("2026-06-01T00:00:00Z"),
      },
    ],
    cash: {
      availableKrw: "1000000",
      lockedKrw: "0",
      totalKrw: "1000000",
      source: "paper_broker",
      observedAt: new Date("2026-06-01T00:00:00Z"),
    },
    costQuality: [
      {
        strategyId: "trend",
        market: "KRW-BTC",
        spreadCostBps: "1",
        slippageBps: "1",
        cancelRequotePenaltyBps: "0",
        source: "test_cost_quality",
      },
    ],
    pnlSnapshots: [],
    reconcileFacts: [],
  };
}

// ── memory-backed repository for tests ──────────────────────────────────────

class MemoryPnlRepository implements PnLAccountingSnapshotPersistencePort {
  private stored: Map<string, PnlSnapshotRecord> = new Map();

  public async persistPnlSnapshot(
    input: PersistPnLAccountingSnapshotInput,
  ): Promise<PnLAccountingSnapshotPersistenceResult> {
    const capturedAt = normalizeCapturedAt(input.capturedAt);
    const inserted: PnlSnapshotRecord[] = [];

    for (const scope of input.output.scopes) {
      const key = `${capturedAt}|${scope.strategyId}|${scope.market ?? "*"}|${input.sourceFingerprint}`;
      const existing = this.stored.get(key);
      if (existing !== undefined) {
        inserted.push(existing);
        continue;
      }

      const record: PnlSnapshotRecord = {
        strategy_id: scope.strategyId,
        market: scope.market,
        captured_at: new Date(capturedAt),
        equity: input.output.equityKrw ?? "0",
        realized_pnl: input.output.realizedPnlKrw ?? "0",
        unrealized_pnl: input.output.unrealizedPnlKrw ?? "0",
        drawdown_bps: input.drawdownBps,
        payload_json: {
          status: input.output.status,
          sourceFingerprint: input.sourceFingerprint,
        },
      };

      this.stored.set(key, record);
      inserted.push(record);
    }

    return {
      inserted: inserted.length > 0,
      snapshots: inserted,
    };
  }
}

function normalizeCapturedAt(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ── 테스트 ──────────────────────────────────────────────────────────────────

describe("M17 PnL accounting closeout", () => {
  it("계산 결과를 persistence까지 end-to-end로 실행한다", async () => {
    const dataProvider = createFixtureDataProvider(fixtureInput());
    const repository = new MemoryPnlRepository();
    const capturedAt = "2026-06-01T00:00:00.000Z";

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt,
    });

    expect(result.output.status).toBe("CALCULATED");
    expect(result.output.equityKrw).not.toBeNull();
    expect(result.output.realizedPnlKrw).not.toBeNull();
    expect(result.sourceFingerprint).toBeTruthy();
    expect(result.capturedAt).toBe(capturedAt);
    expect(result.drawdownBps).toBe("0");
    expect(result.persisted.inserted).toBe(true);
    expect(result.persisted.snapshots.length).toBeGreaterThan(0);
  });

  it("source fingerprint는 동일 입력과 captured_at에서 항상 같다", async () => {
    const dataProvider = createFixtureDataProvider(fixtureInput());
    const repository = new MemoryPnlRepository();
    const capturedAt = "2026-06-01T00:00:00.000Z";

    const result1 = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt,
    });
    const result2 = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt,
    });

    // 같은 입력 → 같은 fingerprint (deterministic)
    expect(result1.sourceFingerprint).toBe(result2.sourceFingerprint);
    // 두 호출 모두 CALCULATED 상태를 반환한다.
    expect(result1.output.status).toBe("CALCULATED");
    expect(result2.output.status).toBe("CALCULATED");
  });

  it("다른 captured_at에서는 다른 source fingerprint를 만든다", async () => {
    const dataProvider = createFixtureDataProvider(fixtureInput());
    const repository = new MemoryPnlRepository();

    const result1 = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });
    const result2 = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T01:00:00.000Z",
    });

    expect(result1.sourceFingerprint).not.toBe(result2.sourceFingerprint);
  });

  it("비용 evidence만 달라져도 closeout source fingerprint를 다르게 만든다", async () => {
    const input1 = {
      ...fixtureInput(),
      fills: [
        {
          ...fixtureInput().fills[0]!,
          fee: "0.00001",
          feeCurrency: "BTC",
        },
      ],
    };
    const input2 = {
      ...fixtureInput(),
      fills: [
        {
          ...fixtureInput().fills[0]!,
          fee: "0.00002",
          feeCurrency: "BTC",
        },
      ],
    };

    const result1 = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(input1),
      repository: new MemoryPnlRepository(),
      capturedAt: "2026-06-01T00:00:00.000Z",
    });
    const result2 = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(input2),
      repository: new MemoryPnlRepository(),
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result1.output.totalPnlKrw).toBe(result2.output.totalPnlKrw);
    expect(result1.sourceFingerprint).not.toBe(result2.sourceFingerprint);
  });

  it("포지션 detail evidence만 달라져도 closeout source fingerprint를 다르게 만든다", async () => {
    const input1: PnLAccountingInput = {
      ...fixtureInput(),
      fills: [
        {
          ...fixtureInput().fills[0]!,
          price: "100000000",
          quantity: "0.01",
          fee: "0",
        },
      ],
      markPrices: [
        {
          ...fixtureInput().markPrices[0]!,
          priceKrw: "101000000",
        },
      ],
    };
    const input2: PnLAccountingInput = {
      ...fixtureInput(),
      fills: [
        {
          ...fixtureInput().fills[0]!,
          price: "50000000",
          quantity: "0.02",
          fee: "0",
        },
      ],
      markPrices: [
        {
          ...fixtureInput().markPrices[0]!,
          priceKrw: "50500000",
        },
      ],
    };

    const result1 = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(input1),
      repository: new MemoryPnlRepository(),
      capturedAt: "2026-06-01T00:00:00.000Z",
    });
    const result2 = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(input2),
      repository: new MemoryPnlRepository(),
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result1.output.totalPnlKrw).toBe(result2.output.totalPnlKrw);
    expect(result1.output.positionMarketValueKrw).toBe(result2.output.positionMarketValueKrw);
    expect(result1.output.equityKrw).toBe(result2.output.equityKrw);
    expect(result1.output.positions[0]!.quantity).not.toBe(result2.output.positions[0]!.quantity);
    expect(result1.sourceFingerprint).not.toBe(result2.sourceFingerprint);
  });

  it("captured_at 없으면 provider source timestamp를 사용한다", async () => {
    let observedCapturedAt: Date | string | undefined = "not-called";
    const dataProvider: PnLAccountingDataProvider = {
      async loadPnLAccountingInput(capturedAt?: Date | string): Promise<PnLAccountingInput> {
        observedCapturedAt = capturedAt;
        return fixtureInput();
      },
      async loadPnLAccountingSnapshotHistory(): Promise<readonly PnLSnapshotFact[]> {
        return [];
      },
    };
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
    });

    expect(observedCapturedAt).toBeUndefined();
    expect(result.capturedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("captured_at 없으면 최신 valuation source timestamp를 사용한다", async () => {
    const input: PnLAccountingInput = {
      ...fixtureInput(),
      markPrices: [
        {
          ...fixtureInput().markPrices[0]!,
          observedAt: new Date("2026-06-01T00:10:00Z"),
        },
      ],
    };
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(input),
      repository,
    });

    expect(result.capturedAt).toBe("2026-06-01T00:10:00.000Z");
  });

  it("drawdown history의 이전 snapshot equity가 더 낮으면 drawdown은 0이다", async () => {
    const previousSnapshot: PnLSnapshotFact = {
      strategyId: "trend",
      market: "KRW-BTC",
      capturedAt: new Date("2026-05-30T00:00:00Z"),
      equity: "1500000",
      realizedPnl: "0",
      unrealizedPnl: "0",
      drawdownBps: "0",
    };

    const dataProvider = createFixtureDataProvider(fixtureInput(), [previousSnapshot]);
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result.output.equityKrw).toBe("2010000");
    expect(result.drawdownBps).toBe("0");
  });

  it("persist되는 aggregate scope의 peak equity보다 current equity가 낮으면 양수 drawdown을 산출한다", async () => {
    const previousSnapshot: PnLSnapshotFact = {
      strategyId: "trend",
      market: null,
      capturedAt: new Date("2026-05-30T00:00:00Z"),
      equity: "3000000",
      realizedPnl: "0",
      unrealizedPnl: "0",
      drawdownBps: "0",
    };

    const dataProvider = createFixtureDataProvider(fixtureInput(), [previousSnapshot]);
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result.output.equityKrw).toBe("2010000");
    expect(result.drawdownBps).toBe("3300");
  });

  it("aggregate snapshot closeout에서 market scope history를 drawdown peak로 섞지 않는다", async () => {
    const marketSnapshot: PnLSnapshotFact = {
      strategyId: "trend",
      market: "KRW-BTC",
      capturedAt: new Date("2026-05-30T00:00:00Z"),
      equity: "3000000",
      realizedPnl: "0",
      unrealizedPnl: "0",
      drawdownBps: "0",
    };

    const dataProvider = createFixtureDataProvider(fixtureInput(), [marketSnapshot]);
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result.output.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategyId: "trend", market: null }),
        expect.objectContaining({ strategyId: "trend", market: "KRW-BTC" }),
      ]),
    );
    expect(result.output.equityKrw).toBe("2010000");
    expect(result.drawdownBps).toBe("0");
  });

  it("drawdown history만 달라져도 source fingerprint는 유지한다", async () => {
    const previousSnapshot: PnLSnapshotFact = {
      strategyId: "trend",
      market: null,
      capturedAt: new Date("2026-05-30T00:00:00Z"),
      equity: "3000000",
      realizedPnl: "0",
      unrealizedPnl: "0",
      drawdownBps: "0",
    };
    const capturedAt = "2026-06-01T00:00:00.000Z";

    const withoutDrawdown = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(fixtureInput()),
      repository: new MemoryPnlRepository(),
      capturedAt,
    });
    const withDrawdown = await runPnLAccountingCloseout({
      dataProvider: createFixtureDataProvider(fixtureInput(), [previousSnapshot]),
      repository: new MemoryPnlRepository(),
      capturedAt,
    });

    expect(withoutDrawdown.drawdownBps).toBe("0");
    expect(withDrawdown.drawdownBps).toBe("3300");
    expect(withoutDrawdown.sourceFingerprint).toBe(withDrawdown.sourceFingerprint);
  });

  it("현재 계산 source의 pnlSnapshots를 drawdown history로 재사용하지 않는다", async () => {
    const currentSourceSnapshot: PnLSnapshotFact = {
      strategyId: "trend",
      market: null,
      capturedAt: new Date("2026-05-30T00:00:00Z"),
      equity: "3000000",
      realizedPnl: "0",
      unrealizedPnl: "0",
      drawdownBps: "0",
    };

    const input: PnLAccountingInput = {
      ...fixtureInput(),
      pnlSnapshots: [currentSourceSnapshot],
    };

    const dataProvider = createFixtureDataProvider(input);
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    // 현재 source snapshot은 calculator 입력으로만 쓰고, 별도 history method가 없으면 drawdown peak 후보로 재사용하지 않는다.
    expect(result.output.equityKrw).toBe("3000000");
    expect(result.drawdownBps).toBe("0");
  });

  it("equity가 null이면 drawdown은 0이다", async () => {
    const input: PnLAccountingInput = {
      fills: [],
      positions: [],
      markPrices: [],
      cash: null,
      costQuality: [],
      pnlSnapshots: [],
      reconcileFacts: [],
    };

    const dataProvider = createFixtureDataProvider(input);
    const repository = new MemoryPnlRepository();

    const result = await runPnLAccountingCloseout({
      dataProvider,
      repository,
      capturedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(result.drawdownBps).toBe("0");
    expect(result.output.equityKrw).toBeNull();
  });
});

describe("M17 PnL accounting status provider", () => {
  it("pnl_snapshots 테이블이 비어 있으면 NOT_FOUND와 null 값을 반환한다", async () => {
    const provider = createDatabasePnLAccountingStatusProvider(pnlSnapshotStatusDatabase(undefined));

    await expect(provider.getStatus()).resolves.toMatchObject({
      readStatus: "NOT_FOUND",
      latestCapturedAt: null,
      latestEquityKrw: null,
      snapshotCount: 0,
      reason: "pnl_snapshot_not_found",
    });
  });

  it("최신 pnl snapshot row를 status summary로 반환한다", async () => {
    const provider = createDatabasePnLAccountingStatusProvider(
      pnlSnapshotStatusDatabase({
        strategy_id: "trend",
        market: null,
        captured_at: new Date("2026-06-01T00:00:00.000Z"),
        equity: "2010000",
        realized_pnl: "0",
        unrealized_pnl: "10000",
        drawdown_bps: "3300",
        payload_json: {
          status: "CALCULATED",
          sourceFingerprint: "fingerprint-1",
        },
      }, false, 3),
    );

    await expect(provider.getStatus()).resolves.toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-01T00:00:00.000Z",
      latestEquityKrw: "2010000",
      latestRealizedPnlKrw: "0",
      latestUnrealizedPnlKrw: "10000",
      latestDrawdownBps: "3300",
      latestSource: "pnl_snapshots",
      latestStatus: "CALCULATED",
      snapshotCount: 3,
      reason: "pnl_snapshot_latest_read",
    });
  });

  it("전역 status는 최신 market row보다 aggregate row를 우선한다", async () => {
    const provider = createDatabasePnLAccountingStatusProvider(
      pnlSnapshotStatusDatabase([
        {
          strategy_id: "trend",
          market: "KRW-BTC",
          captured_at: new Date("2026-06-01T01:00:00.000Z"),
          equity: "1010000",
          realized_pnl: "0",
          unrealized_pnl: "10000",
          drawdown_bps: "1200",
          payload_json: {
            status: "CALCULATED",
            sourceFingerprint: "market-fingerprint",
          },
        },
        {
          strategy_id: "trend",
          market: null,
          captured_at: new Date("2026-06-01T00:00:00.000Z"),
          equity: "2010000",
          realized_pnl: "1000",
          unrealized_pnl: "10000",
          drawdown_bps: "3300",
          payload_json: {
            status: "PARTIAL",
            sourceFingerprint: "aggregate-fingerprint",
          },
        },
      ]),
    );

    await expect(provider.getStatus()).resolves.toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-01T00:00:00.000Z",
      latestEquityKrw: "2010000",
      latestRealizedPnlKrw: "1000",
      latestUnrealizedPnlKrw: "10000",
      latestDrawdownBps: "3300",
      latestSource: "pnl_snapshots",
      latestStatus: "PARTIAL",
      snapshotCount: 2,
      reason: "pnl_snapshot_latest_read",
    });
  });

  it("DB 조회 실패는 빈 테이블과 구분해 UNAVAILABLE로 반환한다", async () => {
    const provider = createDatabasePnLAccountingStatusProvider(pnlSnapshotStatusDatabase(undefined, true));

    await expect(provider.getStatus()).resolves.toMatchObject({
      readStatus: "UNAVAILABLE",
      latestCapturedAt: null,
      latestEquityKrw: null,
      snapshotCount: 0,
      reason: "pnl_snapshot_query_failed",
    });
  });
});

/**
 * status provider fake query가 누적한 where 조건이다.
 *
 * 실제 Kysely query builder처럼 latest row 선택 경계와 count 경계를 분리해
 * 전역 status가 market row를 최신값으로 잘못 선택하는 회귀를 테스트한다.
 */
interface PnlSnapshotStatusQueryFilter {
  strategyId?: string;
  marketEquals?: string;
  marketIsNull?: boolean;
}

function pnlSnapshotStatusDatabase(
  rowOrRows: PnlSnapshotRecord | readonly PnlSnapshotRecord[] | undefined,
  shouldThrow = false,
  snapshotCount = rowOrRows === undefined
    ? 0
    : Array.isArray(rowOrRows)
      ? rowOrRows.length
      : 1,
): Database {
  const rows = rowOrRows === undefined
    ? []
    : Array.isArray(rowOrRows)
      ? [...rowOrRows]
      : [rowOrRows];

  return {
    selectFrom(tableName: string) {
      if (tableName !== "pnl_snapshots") {
        throw new Error(`unexpected table: ${tableName}`);
      }
      return createPnlSnapshotStatusQuery(rows, shouldThrow, snapshotCount);
    },
  } as unknown as Database;
}

function createPnlSnapshotStatusQuery(
  rows: readonly PnlSnapshotRecord[],
  shouldThrow: boolean,
  snapshotCount: number,
) {
  let mode: "latest" | "count" = "latest";
  const filter: PnlSnapshotStatusQueryFilter = {};
  const query = {
    selectAll() {
      mode = "latest";
      return query;
    },
    select(selection?: unknown) {
      if (typeof selection === "function") {
        mode = "count";
      }
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    where(columnName: string, operator: string, value?: unknown) {
      if (columnName === "strategy_id" && operator === "=" && typeof value === "string") {
        filter.strategyId = value;
      }
      if (columnName === "market" && operator === "is" && value === null) {
        filter.marketIsNull = true;
        delete filter.marketEquals;
      }
      if (columnName === "market" && operator === "=" && typeof value === "string") {
        filter.marketEquals = value;
        filter.marketIsNull = false;
      }
      return query;
    },
    async executeTakeFirst() {
      if (shouldThrow) {
        throw new Error("pnl_snapshots unavailable");
      }
      if (mode === "count") {
        return { count: String(snapshotCount) };
      }

      return selectLatestMatchingRow(rows, filter);
    },
  };
  return query;
}

function selectLatestMatchingRow(
  rows: readonly PnlSnapshotRecord[],
  filter: PnlSnapshotStatusQueryFilter,
): PnlSnapshotRecord | undefined {
  return rows
    .filter((row) => {
      if (filter.strategyId !== undefined && row.strategy_id !== filter.strategyId) {
        return false;
      }
      if (filter.marketIsNull === true && row.market !== null) {
        return false;
      }
      if (filter.marketEquals !== undefined && row.market !== filter.marketEquals) {
        return false;
      }
      return true;
    })
    .sort((left, right) => toTime(right.captured_at) - toTime(left.captured_at))[0];
}

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
