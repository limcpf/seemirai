import type {
  PnLAccountingStatusProvider,
  PnLAccountingStatusReadStatus,
  PnLAccountingStatusSummary,
} from "../../../application/pnl-accounting.js";
import type { Database } from "../database.js";
import type { PnlSnapshotRecord } from "./types.js";

/**
 * DB에서 최신 PnL snapshot을 읽어 status provider를 만든다.
 *
 * infrastructure layer가 PostgreSQL schema와 query 조립을 소유하고, application layer에는
 * `PnLAccountingStatusProvider` port와 summary 타입만 노출한다. 조회 실패는 예외를 전파하지 않고
 * `readStatus=UNAVAILABLE`로 낮춰 `/status` endpoint 전체 장애를 막는다.
 *
 * @param database Kysely database handle
 * @param scope 선택적 strategy/market 필터
 * @returns PnL 회계 status provider
 */
export function createDatabasePnLAccountingStatusProvider(
  database: Database,
  scope?: { strategyId?: string; market?: string | null },
): PnLAccountingStatusProvider {
  return {
    async getStatus(): Promise<PnLAccountingStatusSummary> {
      try {
        let latestQuery = database
          .selectFrom("pnl_snapshots")
          .selectAll()
          .orderBy("captured_at", "desc")
          .limit(1);
        let countQuery = database
          .selectFrom("pnl_snapshots")
          .select((expressionBuilder) => expressionBuilder.fn.countAll<string>().as("count"));

        if (scope?.strategyId !== undefined) {
          latestQuery = latestQuery.where("strategy_id", "=", scope.strategyId);
          countQuery = countQuery.where("strategy_id", "=", scope.strategyId);
        }

        if (scope?.market === undefined) {
          // 전역/strategy status는 market별 최신 row를 전체 상태처럼 노출하지 않도록 aggregate row만 최신값 후보로 삼는다.
          latestQuery = latestQuery.where("market", "is", null);
        } else if (scope.market === null) {
          latestQuery = latestQuery.where("market", "is", null);
          countQuery = countQuery.where("market", "is", null);
        } else {
          latestQuery = latestQuery.where("market", "=", scope.market);
          countQuery = countQuery.where("market", "=", scope.market);
        }

        const [row, countRow] = await Promise.all([
          latestQuery.executeTakeFirst(),
          countQuery.executeTakeFirst(),
        ]);
        const snapshotCount = parseSnapshotCount(countRow?.count);

        if (row === undefined) {
          return emptyStatus("NOT_FOUND", "pnl_snapshot_not_found");
        }

        // payload는 provider trace라 secret/raw exchange payload를 노출하지 않고 stable 필드만 summary로 승격한다.
        const payload = readPayloadJson(row);
        const source = typeof payload.sourceFingerprint === "string"
          ? "pnl_snapshots"
          : null;
        const status = typeof payload.status === "string"
          ? payload.status
          : null;

        return {
          readStatus: "OK",
          latestCapturedAt: toIsoString(row.captured_at),
          latestEquityKrw: row.equity,
          latestRealizedPnlKrw: row.realized_pnl,
          latestUnrealizedPnlKrw: row.unrealized_pnl,
          latestDrawdownBps: row.drawdown_bps,
          latestSource: source,
          latestStatus: status,
          snapshotCount,
          reason: "pnl_snapshot_latest_read",
        };
      } catch {
        // query 조립과 실행 실패는 모두 운영자에게 "조회 불가"로 표시해야 하므로 빈 테이블과 분리한다.
        return emptyStatus("UNAVAILABLE", "pnl_snapshot_query_failed");
      }
    },
  };
}

function emptyStatus(
  readStatus: Exclude<PnLAccountingStatusReadStatus, "OK">,
  reason: string,
): PnLAccountingStatusSummary {
  return {
    readStatus,
    latestCapturedAt: null,
    latestEquityKrw: null,
    latestRealizedPnlKrw: null,
    latestUnrealizedPnlKrw: null,
    latestDrawdownBps: null,
    latestSource: null,
    latestStatus: null,
    snapshotCount: 0,
    reason,
  };
}

function parseSnapshotCount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

/**
 * DB driver가 반환하는 `pnl_snapshots` row에서 payload_json을 안전하게 읽는다.
 *
 * payload_json이 null이거나 object가 아니면 빈 객체를 반환하고, row 자체에 손상을 주지 않는다.
 */
function readPayloadJson(row: Pick<PnlSnapshotRecord, "payload_json">): Record<string, unknown> {
  if (row.payload_json === null || row.payload_json === undefined) {
    return {};
  }

  if (typeof row.payload_json !== "object" || Array.isArray(row.payload_json)) {
    return {};
  }

  return row.payload_json as Record<string, unknown>;
}

/**
 * Date 또는 ISO timestamp 입력을 ISO 8601 문자열로 정규화한다.
 *
 * null/undefined는 관측값 부재를 의미하므로 null로 유지한다.
 */
function toIsoString(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
