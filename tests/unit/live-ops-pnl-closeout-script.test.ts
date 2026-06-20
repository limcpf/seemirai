import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const supportModulePath = path.join(
  process.cwd(),
  "scripts",
  "run-live-ops-pnl-closeout-support.mjs",
);

describe("Issue 206 live:ops PnL closeout runner", () => {
  it("clean reconcile/balance source에서 CALCULATED PnL snapshot을 append-only로 저장한다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-1",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        {
          currency: "KRW",
          available: "50000",
          locked: "0",
          total: "50000",
          captured_at: "2026-06-20T05:00:00.000Z",
        },
        {
          currency: "BTC",
          available: "0",
          locked: "0",
          total: "0",
          captured_at: "2026-06-20T05:00:00.000Z",
        },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "ready",
      inserted: true,
      strategyId: "live_ops_cleanup_probe",
      market: "KRW-BTC",
      capturedAt: "2026-06-20T05:00:00.000Z",
      realizedPnlKrw: "0",
      unrealizedPnlKrw: "0",
      drawdownBps: "0",
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      strategy_id: "live_ops_cleanup_probe",
      market: "KRW-BTC",
      equity: "50000",
      realized_pnl: "0",
      unrealized_pnl: "0",
      drawdown_bps: "0",
      payload_json: expect.objectContaining({
        status: "CALCULATED",
        source: "live_ops_pnl_closeout_preflight",
        sourceFingerprint: expect.any(String),
      }),
    });
    expect(JSON.stringify(insertedRows[0])).not.toContain("fake-secret");
    expect(pool.connectCalled()).toBe(true);
  });

  it("open order나 mismatch가 남은 reconcile에서는 PnL snapshot을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-2",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 1,
        mismatch_count: 0,
      },
      balances: [
        {
          currency: "KRW",
          available: "50000",
          locked: "0",
          total: "50000",
          captured_at: "2026-06-20T05:00:00.000Z",
        },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_reconcile_not_clean",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("KRW balance snapshot이 없으면 equity 0 row를 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-3",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        {
          currency: "BTC",
          available: "0",
          locked: "0",
          total: "0",
          captured_at: "2026-06-20T05:00:00.000Z",
        },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_krw_balance_missing",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("BTC 잔고가 있는데 position snapshot이 없으면 CALCULATED snapshot을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-4",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_position_missing_for_balance",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("position 수량이 있는데 BTC balance row가 없으면 평가액을 0으로 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-5",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0.0001",
        average_entry_price: "90000000",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_base_balance_missing_for_position",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("BTC 잔고가 있는데 position row 수량이 0이면 CALCULATED snapshot을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-5b",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0",
        average_entry_price: "0",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_position_quantity_zero_for_balance",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("position 수량과 BTC balance 수량이 다르면 CALCULATED snapshot을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-5c",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0.0002",
        average_entry_price: "90000000",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_position_balance_quantity_mismatch",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("양수 position의 평균단가가 0이면 CALCULATED snapshot을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-5d",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0.0001",
        average_entry_price: "0",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_position_average_entry_price_missing",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("orderbook 기준가가 reconcile freshness 한도보다 오래되면 closeout을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-6",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0.0001",
        average_entry_price: "90000000",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      referenceBucketAt: "2026-06-20T04:00:00.000Z",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_reference_price_stale",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("주입된 preflight 기준가도 timestamp가 오래되면 closeout을 만들지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-6b",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0.0001", locked: "0", total: "0.0001", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [{
        strategy_id: "live_ops_cleanup_probe",
        market: "KRW-BTC",
        quantity: "0.0001",
        average_entry_price: "90000000",
        realized_pnl: "0",
        unrealized_pnl: "0",
        updated_at: "2026-06-20T05:00:00.000Z",
      }],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      referencePriceObservedAt: "2026-06-20T04:59:00.000Z",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_reference_price_stale",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("같은 reconcile run의 중복 balance row 중 currency별 최신 snapshot만 사용한다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-7",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 3,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "10000", locked: "0", total: "10000", captured_at: "2026-06-20T04:59:50.000Z" },
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0", locked: "0", total: "0", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "ready",
      equityKrw: "50000",
      inserted: true,
    });
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ equity: "50000" });
  });

  it("최신 PnL row가 manual review면 standalone closeout도 새 CALCULATED row로 덮지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-8",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0", locked: "0", total: "0", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      pnlSnapshots: [{
        strategy_id: "live_ops_cleanup_probe",
        captured_at: "2026-06-20T05:00:00.000Z",
        equity: "50000",
        payload_status: "MANUAL_REVIEW_REQUIRED",
      }],
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_latest_status_not_ready",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("aggregate 최신 PnL row가 manual review면 cleanup closeout으로 가리지 않는다", async () => {
    const { runLiveOpsPnlCloseout } = await import(supportModulePath);
    const insertedRows: unknown[] = [];
    const pool = createFakePnlCloseoutPool({
      latestRun: {
        id: "preflight-run-9",
        status: "COMPLETED",
        finished_at: "2026-06-20T05:00:00.000Z",
        balance_snapshot_count: 1,
        open_order_count: 0,
        mismatch_count: 0,
      },
      balances: [
        { currency: "KRW", available: "50000", locked: "0", total: "50000", captured_at: "2026-06-20T05:00:00.000Z" },
        { currency: "BTC", available: "0", locked: "0", total: "0", captured_at: "2026-06-20T05:00:00.000Z" },
      ],
      positions: [],
      fillsCount: 0,
      referencePrice: "100000000",
      pnlSnapshots: [{
        strategy_id: "aggregate",
        captured_at: "2026-06-20T05:00:00.000Z",
        equity: "50000",
        payload_status: "MANUAL_REVIEW_REQUIRED",
      }],
      insertedRows,
    });

    const result = await runLiveOpsPnlCloseout({
      pool,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      capturedAt: "2026-06-20T05:00:00.000Z",
      referencePrice: "100000000",
      maxReconcileAgeMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "pnl_closeout_latest_status_not_ready",
      inserted: false,
    });
    expect(insertedRows).toHaveLength(0);
    expect(pool.connectCalled()).toBe(false);
  });

  it("open order count query는 잔량 미확인 open order도 차단 대상으로 센다", async () => {
    const source = await readFile(supportModulePath, "utf8");

    expect(source).toContain("remaining_quantity IS NULL OR remaining_quantity > 0");
  });
});

function createFakePnlCloseoutPool(options: {
  latestRun: Record<string, unknown> | undefined;
  balances: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  fillsCount: number;
  referencePrice: string | null;
  referenceBucketAt?: string;
  pnlSnapshots?: Array<Record<string, unknown>>;
  insertedRows: unknown[];
}) {
  let connectCalled = false;

  const query = async (sql: string, params: unknown[] = []) => {
    const text = sql.replace(/\s+/gu, " ").trim();
    if (text.includes("FROM live_reconcile_runs")) {
      return { rows: options.latestRun === undefined ? [] : [options.latestRun] };
    }
    if (text.includes("FROM live_reconcile_balance_snapshots")) {
      return { rows: options.balances };
    }
    if (text.includes("FROM positions")) {
      return { rows: options.positions };
    }
    if (text.includes("FROM fills")) {
      return { rows: [{ count: options.fillsCount }] };
    }
    if (text.includes("FROM orderbook_metrics")) {
      return {
        rows: options.referencePrice === null
          ? []
          : [{
              best_bid_price: options.referencePrice,
              best_ask_price: options.referencePrice,
              bucket_at: options.referenceBucketAt ?? params[1] ?? "2026-06-20T05:00:00.000Z",
            }],
      };
    }
    if (text.includes("payload_json ->> 'status' AS payload_status")) {
      return { rows: selectFakePnlStatusRows(options.pnlSnapshots ?? [], text, params) };
    }
    if (text.includes("FROM pnl_snapshots")) {
      return {
        rows: (options.pnlSnapshots ?? []).filter((row) => row.payload_status === "CALCULATED"),
      };
    }
    throw new Error(`unexpected pool query: ${text}`);
  };

  return {
    async query(sql: string, params?: unknown[]) {
      return query(sql, params);
    },
    async connect() {
      connectCalled = true;
      return {
        async query(sql: string, params: unknown[] = []) {
          const text = sql.replace(/\s+/gu, " ").trim();
          if (
            text === "BEGIN" ||
            text === "COMMIT" ||
            text === "ROLLBACK" ||
            text.includes("pg_advisory_xact_lock")
          ) {
            return { rows: [] };
          }
          if (text.startsWith("SELECT strategy_id")) {
            return { rows: [] };
          }
          if (text.startsWith("INSERT INTO pnl_snapshots")) {
            const row = {
              strategy_id: params[0],
              market: params[1],
              captured_at: params[2],
              equity: params[3],
              realized_pnl: params[4],
              unrealized_pnl: params[5],
              drawdown_bps: params[6],
              payload_json: JSON.parse(String(params[7])),
            };
            options.insertedRows.push(row);
            return { rows: [row] };
          }
          throw new Error(`unexpected client query: ${text}`);
        },
        release() {
          return undefined;
        },
      };
    },
    connectCalled() {
      return connectCalled;
    },
  };
}

function selectFakePnlStatusRows(
  rows: Array<Record<string, unknown>>,
  sql: string,
  params: unknown[],
): Array<Record<string, unknown>> {
  const strategyId = String(params[0]);
  const includesFallbackScopes = sql.includes("strategy_id IS NULL") || sql.includes("'global'") || sql.includes("'aggregate'");
  return rows
    .filter((row) => {
      const rowStrategy = row.strategy_id === undefined || row.strategy_id === null ? null : String(row.strategy_id);
      if (rowStrategy === strategyId) {
        return true;
      }
      return includesFallbackScopes && (rowStrategy === null || rowStrategy === "global" || rowStrategy === "aggregate");
    })
    .sort((left, right) => Date.parse(String(right.captured_at)) - Date.parse(String(left.captured_at)));
}
