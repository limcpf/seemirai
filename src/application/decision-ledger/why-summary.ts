import type {
  WhySummary,
  WhyMarketSummarySection,
  WhyMarketSummary,
  WhyStrategySummarySection,
  WhyStrategySummary,
  WhyCashSummarySection,
  WhyCashSummary,
  WhyCashHoldReasonSummary,
  WhyReadStatus,
  WhySummaryTrace,
} from "./types.js";
import type { DecisionFrameCategory, SummaryStatus } from "./category.js";
import { toCategoryLabel, toWhyStatusMessages, toHoldReasonLabel } from "./user-facing.js";

/**
 * `/status` 하위 read-only `why` summary를 DB 또는 fixture에서 조회하기 위한 application port다.
 *
 * 이 port는 `interfaces/http-control`이 DB 구현을 직접 알지 않고 왜(why) summary를 받을 수 있게 한다.
 * DB-backed 구현은 `src/infrastructure/db/decision-ledger/status-provider.ts`에 둔다.
 */
export interface WhySummaryProvider {
  /**
   * decision ledger에서 최신 판단 이유 summary를 조회한다.
   *
   * 모든 section의 조회가 실패해도 endpoint를 실패시키지 않고 section별 `UNAVAILABLE`로 낮춘다.
   *
   * @returns WhySummary
   */
  getWhySummary(): Promise<WhySummary>;
}

/**
 * market별 최근 frame record의 최소 projection이다.
 *
 * why summary는 DB row 전체를 노출하지 않고 market code, category, 최신 시각, reason count만 사용한다.
 */
export interface WhyFrameProjection {
  readonly market: string | null;
  readonly category: DecisionFrameCategory | null;
  readonly summaryStatus: SummaryStatus;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly latestDecisionAt: Date | null;
  readonly trace: Record<string, unknown>;
}

/**
 * strategy별 최근 frame record의 최소 projection이다.
 */
export interface WhyStrategyFrameProjection {
  readonly strategyId: string | null;
  readonly category: DecisionFrameCategory | null;
  readonly summaryStatus: SummaryStatus;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly latestDecisionAt: Date | null;
  readonly trace: Record<string, unknown>;
}

/**
 * cash hold frame record의 최소 projection이다.
 */
export interface WhyCashFrameProjection {
  readonly category: DecisionFrameCategory | null;
  readonly summaryStatus: SummaryStatus;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly latestDecisionAt: Date | null;
  readonly trace: Record<string, unknown>;
}

/**
 * frame projection을 조회한 결과를 묶는 입력이다.
 */
export interface WhyProjections {
  readonly markets: readonly WhyFrameProjection[];
  readonly strategies: readonly WhyStrategyFrameProjection[];
  readonly cashFrames: readonly WhyCashFrameProjection[];
}

/**
 * frame projection 목록에서 WhySummary를 순수하게 빌드한다.
 *
 * 이 함수는 순수 변환 함수이며 DB나 외부 side effect가 없다.
 * 호출자는 DB에서 조회한 projection을 이 함수에 전달하고, 결과를 HTTP 응답으로 직렬화한다.
 *
 * @param projections frame projection 묶음
 * @param generatedAt summary 생성 시각 (ISO 8601)
 * @returns WhySummary
 */
export function buildWhySummary(
  projections: WhyProjections,
  generatedAt: string,
): WhySummary {
  const markets = buildMarketSection(projections.markets);
  const strategies = buildStrategySection(projections.strategies);
  const cash = buildCashSection(projections.cashFrames);

  const allOk =
    markets.readStatus === "OK" &&
    strategies.readStatus === "OK" &&
    cash.readStatus === "OK";

  const anyUnavailable =
    markets.readStatus === "UNAVAILABLE" ||
    strategies.readStatus === "UNAVAILABLE" ||
    cash.readStatus === "UNAVAILABLE";

  const readStatus: WhyReadStatus = allOk
    ? "OK"
    : anyUnavailable
      ? "UNAVAILABLE"
      : "NOT_FOUND";

  return {
    markets,
    strategies,
    cash,
    generatedAt,
    readStatus,
    trace: {
      querySource: "decision_ledger_frames",
      marketCount: projections.markets.length,
      strategyCount: projections.strategies.length,
      cashFrameCount: projections.cashFrames.length,
    },
  };
}

function buildMarketSection(
  projections: readonly WhyFrameProjection[],
): WhyMarketSummarySection {
  if (projections.length === 0) {
    return {
      readStatus: "NOT_FOUND",
      statusLabel: "기록 없음",
      message: "시장별 판단 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      items: [],
      trace: {},
    };
  }

  const items: WhyMarketSummary[] = [];
  for (const projection of projections) {
    const market = projection.market ?? "전체";
    const category = projection.category;
    const messages = toWhyStatusMessages(category, market);
    const trace: WhySummaryTrace = {
      ...projection.trace,
      category,
      summaryStatus: projection.summaryStatus,
    };

    items.push({
      market,
      statusLabel: messages.statusLabel,
      message: messages.message,
      impact: messages.impact,
      action: messages.action,
      latestDecisionAt: projection.latestDecisionAt?.toISOString() ?? null,
      trace,
    });
  }

  return {
    readStatus: "OK",
    statusLabel: "조회 완료",
    message: "시장별 최근 판단 이유를 조회했습니다.",
    impact: null,
    action: null,
    items,
    trace: { querySource: "decision_ledger_frames" },
  };
}

function buildStrategySection(
  projections: readonly WhyStrategyFrameProjection[],
): WhyStrategySummarySection {
  if (projections.length === 0) {
    return {
      readStatus: "NOT_FOUND",
      statusLabel: "기록 없음",
      message: "전략별 판단 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      items: [],
      trace: {},
    };
  }

  const items: WhyStrategySummary[] = [];
  for (const projection of projections) {
    const strategyId = projection.strategyId ?? "unknown";
    const category = projection.category;
    const messages = toWhyStatusMessages(category);
    const trace: WhySummaryTrace = {
      ...projection.trace,
      category,
      summaryStatus: projection.summaryStatus,
    };

    items.push({
      strategyId,
      statusLabel: messages.statusLabel,
      message: messages.message,
      impact: messages.impact,
      action: messages.action,
      latestDecisionAt: projection.latestDecisionAt?.toISOString() ?? null,
      trace,
    });
  }

  return {
    readStatus: "OK",
    statusLabel: "조회 완료",
    message: "전략별 최근 판단 이유를 조회했습니다.",
    impact: null,
    action: null,
    items,
    trace: { querySource: "decision_ledger_frames" },
  };
}

function buildCashSection(
  projections: readonly WhyCashFrameProjection[],
): WhyCashSummarySection {
  if (projections.length === 0) {
    return {
      readStatus: "NOT_FOUND",
      statusLabel: "기록 없음",
      message: "현금 보유 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      item: null,
      trace: {},
    };
  }

  // 가장 최근 cash frame을 사용
  const latest = projections[0]!;
  const category = latest.category;
  const messages = toWhyStatusMessages(category);

  // reason count를 hold reason summary로 변환
  const holdReasons: WhyCashHoldReasonSummary[] = Object.entries(
    latest.reasonCounts,
  )
    .filter(([_key, count]) => count > 0)
    .sort(([, a], [, b]) => b - a)
    .map(([reasonCode, count]) => ({
      label: toHoldReasonLabel(reasonCode),
      count,
      trace: { reasonCode },
    }));

  const trace: WhySummaryTrace = {
    ...latest.trace,
    category,
    summaryStatus: latest.summaryStatus,
  };

  const item: WhyCashSummary = {
    statusLabel: messages.statusLabel,
    message: messages.message,
    impact: messages.impact,
    action: messages.action,
    latestDecisionAt: latest.latestDecisionAt?.toISOString() ?? null,
    holdReasons,
    trace,
  };

  return {
    readStatus: "OK",
    statusLabel: "조회 완료",
    message: "현금 보유 이유를 조회했습니다.",
    impact: null,
    action: null,
    item,
    trace: { querySource: "decision_ledger_frames" },
  };
}
