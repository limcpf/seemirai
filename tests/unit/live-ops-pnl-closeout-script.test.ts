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
});

function createFakePnlCloseoutPool(options: {
  latestRun: Record<string, unknown> | undefined;
  balances: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  fillsCount: number;
  referencePrice: string | null;
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
              bucket_at: params[1] ?? "2026-06-20T05:00:00.000Z",
            }],
      };
    }
    if (text.includes("FROM pnl_snapshots")) {
      return { rows: [] };
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
