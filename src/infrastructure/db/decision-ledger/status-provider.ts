import type { Database } from "../database.js";
import type {
  WhySummaryProvider,
  WhyProjections,
  WhyFrameProjection,
  WhyStrategyFrameProjection,
  WhyCashFrameProjection,
} from "../../../application/decision-ledger/why-summary.js";
import { buildWhySummary } from "../../../application/decision-ledger/why-summary.js";
import type { WhySummary } from "../../../application/decision-ledger.js";

/**
 * decision ledger DB에서 최신 frame을 읽어 `/status.why` summary를 만드는 provider다.
 *
 * 이 구현은 read-only DB query만 수행하며, write side effect를 만들지 않는다.
 * DB가 연결되지 않았거나 query가 실패하면 UNAVAILABLE summary를 반환한다.
 *
 * ## 조회 방식
 *
 * - market별: `market IS NOT NULL`인 frame을 market별로 group해 최신 1건씩
 * - strategy별: `strategy_id IS NOT NULL`인 frame을 strategy별로 group해 최신 1건씩
 * - cash: `category = 'CASH_HOLD'`인 frame 중 최신 1건
 */
export function createDatabaseWhySummaryProvider(
  database: Database,
  clock: () => Date = () => new Date(),
): WhySummaryProvider {
  return {
    async getWhySummary(): Promise<WhySummary> {
      try {
        const [marketFrames, strategyFrames, cashFrames] = await Promise.all([
          queryLatestMarketFrames(database),
          queryLatestStrategyFrames(database),
          queryLatestCashFrames(database),
        ]);

        const projections: WhyProjections = {
          markets: marketFrames,
          strategies: strategyFrames,
          cashFrames,
        };

        return buildWhySummary(projections, clock().toISOString());
      } catch {
        // DB 조회 실패는 빈 NOT_FOUND로 낮추지 않고, 명시적 UNAVAILABLE summary를 반환한다.
        // 운영자가 migration/권한 문제를 "아직 데이터 없음"으로 오해하지 않게 하기 위함이다.
        return createUnavailableWhySummary(clock().toISOString());
      }
    },
  };
}

/**
 * market별 최신 frame을 조회한다.
 */
async function queryLatestMarketFrames(
  database: Database,
): Promise<readonly WhyFrameProjection[]> {
  const rows = await database
    .selectFrom("decision_ledger_frames")
    .select([
      "market",
      "category",
      "summary_status",
      "reason_counts_json",
      "decision_at",
      "trace_json",
    ])
    .where("market", "is not", null)
    .orderBy("market", "asc")
    .orderBy("decision_at", "desc")
    .orderBy("id", "desc")
    .execute();

  // decision_at이 같은 frame이 여러 개여도 id desc tie-breaker 기준 market별 최신 1건만 노출한다.
  return uniqueBy(rows, (row) => row.market).map((row) => ({
    market: row.market,
    category: row.category as WhyFrameProjection["category"],
    summaryStatus: row.summary_status as WhyFrameProjection["summaryStatus"],
    reasonCounts: (row.reason_counts_json ?? {}) as Record<string, number>,
    latestDecisionAt: row.decision_at,
    trace: (row.trace_json ?? {}) as Record<string, unknown>,
  }));
}

/**
 * strategy별 최신 frame을 조회한다.
 */
async function queryLatestStrategyFrames(
  database: Database,
): Promise<readonly WhyStrategyFrameProjection[]> {
  const rows = await database
    .selectFrom("decision_ledger_frames")
    .select([
      "strategy_id",
      "category",
      "summary_status",
      "reason_counts_json",
      "decision_at",
      "trace_json",
    ])
    .where("strategy_id", "is not", null)
    .orderBy("strategy_id", "asc")
    .orderBy("decision_at", "desc")
    .orderBy("id", "desc")
    .execute();

  return uniqueBy(rows, (row) => row.strategy_id).map((row) => ({
    strategyId: row.strategy_id,
    category: row.category as WhyStrategyFrameProjection["category"],
    summaryStatus: row.summary_status as WhyStrategyFrameProjection["summaryStatus"],
    reasonCounts: (row.reason_counts_json ?? {}) as Record<string, number>,
    latestDecisionAt: row.decision_at,
    trace: (row.trace_json ?? {}) as Record<string, unknown>,
  }));
}

/**
 * 이미 최신순으로 정렬된 DB row 목록에서 key별 첫 row만 남긴다.
 */
function uniqueBy<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string | null,
): readonly Row[] {
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

/**
 * 최신 CASH_HOLD frame을 조회한다.
 */
async function queryLatestCashFrames(
  database: Database,
): Promise<readonly WhyCashFrameProjection[]> {
  const rows = await database
    .selectFrom("decision_ledger_frames")
    .select([
      "category",
      "summary_status",
      "reason_counts_json",
      "decision_at",
      "trace_json",
    ])
    .where("category", "=", "CASH_HOLD")
    .orderBy("decision_at", "desc")
    .limit(1)
    .execute();

  return rows.map((row) => ({
    category: row.category as WhyCashFrameProjection["category"],
    summaryStatus: row.summary_status as WhyCashFrameProjection["summaryStatus"],
    reasonCounts: (row.reason_counts_json ?? {}) as Record<string, number>,
    latestDecisionAt: row.decision_at,
    trace: (row.trace_json ?? {}) as Record<string, unknown>,
  }));
}

/**
 * DB 조회 실패 전용 UNAVAILABLE WhySummary를 생성한다.
 *
 * 빈 projection 기반 NOT_FOUND와 달리, 각 section에 한국어 조회 불가 문구와
 * 조치 방법을 명시해 운영자가 DB 장애를 "아직 데이터 없음"으로 오해하지 않게 한다.
 */
function createUnavailableWhySummary(generatedAt: string): WhySummary {
  return {
    markets: {
      readStatus: "UNAVAILABLE",
      statusLabel: "조회 불가",
      message: "시장별 판단 이유를 DB에서 읽지 못했습니다.",
      impact: "decision ledger DB 연결 또는 쿼리 실패로 시장별 why summary를 조회할 수 없습니다.",
      action: "DB 연결 상태와 decision_ledger_frames table 접근 권한을 확인한 뒤 다시 조회하세요.",
      items: [],
      trace: { querySource: "decision_ledger_frames", reason: "db_query_failed" },
    },
    strategies: {
      readStatus: "UNAVAILABLE",
      statusLabel: "조회 불가",
      message: "전략별 판단 이유를 DB에서 읽지 못했습니다.",
      impact: "decision ledger DB 연결 또는 쿼리 실패로 전략별 why summary를 조회할 수 없습니다.",
      action: "DB 연결 상태와 decision_ledger_frames table 접근 권한을 확인한 뒤 다시 조회하세요.",
      items: [],
      trace: { querySource: "decision_ledger_frames", reason: "db_query_failed" },
    },
    cash: {
      readStatus: "UNAVAILABLE",
      statusLabel: "조회 불가",
      message: "현금 보유 이유를 DB에서 읽지 못했습니다.",
      impact: "decision ledger DB 연결 또는 쿼리 실패로 현금 보유 why summary를 조회할 수 없습니다.",
      action: "DB 연결 상태와 decision_ledger_frames table 접근 권한을 확인한 뒤 다시 조회하세요.",
      item: null,
      trace: { querySource: "decision_ledger_frames", reason: "db_query_failed" },
    },
    generatedAt,
    readStatus: "UNAVAILABLE",
    trace: { querySource: "decision_ledger_frames", reason: "db_query_failed" },
  };
}
