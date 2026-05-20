import { sql } from "kysely";
import type { KillSwitchState } from "../domain/index.js";
import { getKillSwitchActionPlan } from "../domain/index.js";
import type { Database } from "../infrastructure/db/index.js";
import type { RuntimeConfig } from "../runtime/index.js";
import type {
  ControlStatusProvider,
  ControlStatusSnapshot,
  CreateDatabaseControlStatusProviderOptions,
} from "./http-control-types.js";

/**
 * DB snapshot과 safe runtime config만 사용해 `/status` payload를 만든다.
 *
 * status는 운영 대시보드와 수동 점검을 위한 관측면이므로,
 * 일부 집계 조회가 실패해도 endpoint 전체를 실패시키기보다 null로 표시한다.
 */
export function createDatabaseControlStatusProvider(
  options: CreateDatabaseControlStatusProviderOptions,
): ControlStatusProvider {
  const clock = options.clock ?? (() => new Date());

  return {
    async getStatus(): Promise<ControlStatusSnapshot> {
      const killSwitch = await readKillSwitchStatus(options.database);
      const actionPlan = getKillSwitchActionPlan(killSwitch.state);
      const readiness = await options.readinessProvider.check();
      // kill switch action plan은 상태 문자열을 실제 주문 차단/수동 검토 신호로 변환하는 경계다.
      return {
        generatedAt: clock().toISOString(),
        runtime: toSafeRuntimeSummary(options.runtimeConfig),
        tradingState: {
          state: killSwitch.state,
          killSwitchState: killSwitch.state,
          blockedReason: killSwitch.reasonCode,
          newOrdersBlocked: actionPlan.newOrdersBlocked,
          requiresManualReview: actionPlan.requiresManualReview,
        },
        marketData: {
          connectionStatus: options.marketData?.connectionStatus ?? "unknown",
          lagMs: options.marketData?.lagMs ?? null,
          updatedAt: options.marketData?.updatedAt ?? null,
        },
        paper: {
          pendingPaperOrderCount: await countPendingPaperOrders(options.database),
          openPositionCount: await countOpenPositions(options.database),
        },
        database: readiness,
        alerts: {
          lastSentAt: options.alerts?.lastSentAt ?? null,
          lastSkippedAt: options.alerts?.lastSkippedAt ?? null,
        },
        dailyReport: {
          lastStatus: options.dailyReport?.lastStatus ?? "unavailable",
          reportDate: options.dailyReport?.reportDate ?? null,
          updatedAt: options.dailyReport?.updatedAt ?? null,
        },
      };
    },
  };
}

/**
 * durable kill switch state를 읽어 `/status` tradingState로 전달한다.
 *
 * DB가 없을 때는 local/dev 환경의 기본값으로 NORMAL을 쓰고,
 * DB 조회 실패나 row 누락은 운영에서 안전한 MANUAL_REVIEW_REQUIRED로 닫는다.
 */
async function readKillSwitchStatus(
  database: Database | undefined,
): Promise<{ state: KillSwitchState; reasonCode: string | null }> {
  if (database === undefined) {
    return {
      state: "NORMAL",
      reasonCode: null,
    };
  }

  const row = await database
    .selectFrom("kill_switch_state")
    .select(["state", "reason_code"])
    .where("scope", "=", "global")
    .executeTakeFirst()
    .catch(() => undefined);

  // durable state를 읽지 못하면 운영 화면에서 정상 상태로 보이지 않게 수동 검토 상태로 닫는다.
  return {
    state: row?.state ?? "MANUAL_REVIEW_REQUIRED",
    reasonCode: row?.reason_code ?? "kill_switch_state_unavailable",
  };
}

/**
 * status용 paper 주문 대기 건수를 계산한다.
 *
 * 이 값은 관측 편의용이므로 조회 실패 시 `/status` 전체 실패 대신 null로 낮춘다.
 */
async function countPendingPaperOrders(database: Database | undefined): Promise<number | null> {
  if (database === undefined) {
    return null;
  }

  const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM orders
      WHERE status IN ('SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED')
    `
    .execute(database)
    .catch(() => undefined);
  if (result === undefined) {
    // 주문 집계 실패는 readiness 실패와 별개로 status snapshot에서 unknown으로 표현한다.
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

/**
 * status용 open position 수를 계산한다.
 *
 * 포지션 집계도 관측 정보이므로 DB 오류를 endpoint 실패로 확대하지 않는다.
 */
async function countOpenPositions(database: Database | undefined): Promise<number | null> {
  if (database === undefined) {
    return null;
  }

  const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM positions
      WHERE quantity::numeric <> 0
    `
    .execute(database)
    .catch(() => undefined);
  if (result === undefined) {
    // 포지션 집계 실패는 운영자가 구분할 수 있도록 null로 남긴다.
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

/**
 * runtime config에서 운영 노출이 안전한 필드만 골라낸다.
 */
function toSafeRuntimeSummary(config: RuntimeConfig): ControlStatusSnapshot["runtime"] {
  return {
    exchange: config.exchange,
    market: config.market,
    mode: config.mode,
    universe: {
      phase1: config.universe.phase_1,
      phase1Count: config.universe.phase_1.length,
    },
    liveTradingEnabled: config.live_trading_enabled,
    paperNoKey: config.paper_no_key,
  };
}
