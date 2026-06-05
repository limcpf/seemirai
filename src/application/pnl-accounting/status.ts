import type { NumericString } from "../../domain/index.js";
import type { Database } from "../../infrastructure/db/database.js";
import type { PnlSnapshotRecord } from "../../infrastructure/db/pnl-accounting/types.js";

export type PnLAccountingStatusReadStatus = "OK" | "NOT_FOUND" | "UNAVAILABLE";

/**
 * PnL 회계 snapshot에서 읽은 운영 상태 summary다.
 *
 * `/status` endpoint나 daily report, Telegram 알림이 공통으로 읽을 수 있는
 * 최소한의 durable PnL 정보만 포함한다. 모든 금액은 KRW Decimal 문자열이며,
 * snapshot이 없으면 null이다. `readStatus`는 빈 테이블과 DB 조회 실패를 구분해 운영자가 실제 장애를
 * "아직 snapshot 없음"으로 오해하지 않게 하는 상태 축이다.
 */
export interface PnLAccountingStatus {
  /** 최신 snapshot 조회 결과 상태 */
  readStatus: PnLAccountingStatusReadStatus;
  /** 마지막 snapshot 캡처 시각 */
  latestCapturedAt: string | null;
  /** 최근 평가자산 (KRW). snapshot이 없으면 null */
  latestEquityKrw: NumericString | null;
  /** 최근 실현 손익 (KRW) */
  latestRealizedPnlKrw: NumericString | null;
  /** 최근 미실현 손익 (KRW) */
  latestUnrealizedPnlKrw: NumericString | null;
  /** 최근 최대 낙폭 (bps) */
  latestDrawdownBps: NumericString | null;
  /** snapshot source (payload_json에서 추출). 확인 불가면 null */
  latestSource: string | null;
  /** snapshot 상태 (payload_json에서 추출). 확인 불가면 null */
  latestStatus: string | null;
  /** snapshot 개수 (집계 기준). snapshot이 없으면 0 */
  snapshotCount: number;
  /** 조회 실패 또는 빈 결과의 내부 추적 reason */
  reason: string;
}

/**
 * PnL 회계 status provider다.
 *
 * DB 또는 fixture에서 최신 PnL snapshot을 읽어 운영 상태를 반환한다.
 * DB 접근 실패 시 `readStatus=UNAVAILABLE`로 낮추고 예외를 던지지 않는다.
 */
export interface PnLAccountingStatusProvider {
  getStatus(): Promise<PnLAccountingStatus>;
}

/**
 * DB에서 최신 PnL snapshot을 읽어 status provider를 만든다.
 *
 * `pnl_snapshots` 테이블에서 latest `captured_at` 기준 단일 snapshot을 읽는다.
 * strategy/market 필터가 없으면 전체에서 가장 최근 snapshot을 사용한다.
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
    async getStatus(): Promise<PnLAccountingStatus> {
      try {
        let query = database
          .selectFrom("pnl_snapshots")
          .selectAll()
          .orderBy("captured_at", "desc")
          .limit(1);

        if (scope?.strategyId !== undefined) {
          query = query.where("strategy_id", "=", scope.strategyId);
        }

        if (scope?.market !== undefined) {
          if (scope.market === null) {
            query = query.where("market", "is", null);
          } else {
            query = query.where("market", "=", scope.market);
          }
        }

        const row = await query.executeTakeFirst();

        if (row === undefined) {
          return emptyStatus("NOT_FOUND", "pnl_snapshot_not_found");
        }

        // payload_json에서 source와 status를 안전하게 추출한다.
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
          snapshotCount: 1,
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
): PnLAccountingStatus {
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
