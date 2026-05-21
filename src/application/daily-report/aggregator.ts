import { parseFinancialDecimal } from "../../shared/index.js";
import {
  labelDiscardReason,
  labelOrderStatus,
  labelRiskAction,
  labelRiskType,
} from "./user-facing.js";
import type {
  DailyReportAggregate,
  DailyReportAuditEventFact,
  DailyReportCountItem,
  DailyReportDecimalMetric,
  DailyReportExecutionQualityFact,
  DailyReportFeeTotal,
  DailyReportFillFact,
  DailyReportPnlSnapshotFact,
  DailyReportPositionFact,
  DailyReportSourceData,
  DailyReportWindow,
} from "./types.js";

/**
 * 읽기 전용 daily report fact들을 운영 리포트 중간 모델로 집계한다.
 *
 * 이 함수는 DB나 notifier를 호출하지 않는 순수 집계 경계다. 동일한 window와 facts를 넣으면 항상 같은 결과를 반환해야 하며,
 * 데이터가 없는 항목은 임의의 0으로 꾸미지 않고 `available=false`로 남겨 운영자가 결측과 실제 0을 구분할 수 있게 한다.
 */
export function aggregateDailyReport(
  window: DailyReportWindow,
  sourceData: DailyReportSourceData,
): DailyReportAggregate {
  const latestPnlSnapshots = selectLatestPnlSnapshots(sourceData.pnlSnapshots);
  const pnlSnapshotsForAggregation = excludeMarketSnapshotsCoveredByAggregate(latestPnlSnapshots);
  const pnlSource = createPnlSource(pnlSnapshotsForAggregation, sourceData.positions);
  const realizedPnl = createPnlMetric(pnlSource.facts, "realizedPnl", pnlSource.realizedSource);
  const estimatedPnl = createPnlMetric(
    pnlSource.facts,
    "unrealizedPnl",
    pnlSource.estimatedSource,
  );
  const feeTotals = summarizeFees(sourceData.fills);
  const totalFillNotional = summarizeFillNotional(sourceData.fills);

  const aggregate: DailyReportAggregate = {
    window,
    orderCount: sourceData.orders.length,
    fillCount: sourceData.fills.length,
    openPositionCount: countOpenPositions(sourceData.positions),
    orderStatusCounts: countBy(sourceData.orders.map((order) => order.status), labelOrderStatus),
    realizedPnl,
    estimatedPnl,
    feeTotals,
    totalFillNotional,
    feeToFillNotionalBps: calculateFeeToFillNotionalBps(feeTotals, totalFillNotional),
    averageSlippageBps: averageMetric(readQualityMetric(sourceData.executionQuality, "slippageBps"), "bps"),
    averageSpreadCostBps: averageMetric(readQualityMetric(sourceData.executionQuality, "spreadCostBps"), "bps"),
    averageCancelRequotePenaltyBps: averageMetric(
      readQualityMetric(sourceData.executionQuality, "cancelRequotePenaltyBps"),
      "bps",
    ),
    discardedCandidates: summarizeDiscardedCandidates(sourceData.auditEvents),
    riskEvents: summarizeRiskEvents(sourceData),
  };
  const latestPnlSnapshotAt = latestTimestamp(pnlSnapshotsForAggregation.map((snapshot) => snapshot.capturedAt));
  if (latestPnlSnapshotAt !== undefined) {
    aggregate.latestPnlSnapshotAt = latestPnlSnapshotAt;
  }

  return aggregate;
}

function createPnlMetric(
  facts: readonly (DailyReportPnlSnapshotFact | DailyReportPositionFact)[],
  field: "realizedPnl" | "unrealizedPnl",
  source: string,
): DailyReportAggregate["realizedPnl"] {
  if (facts.length === 0) {
    return {
      value: null,
      available: false,
      sampleCount: 0,
      unit: "KRW",
      source: "unavailable",
    };
  }

  return {
    ...sumMetric(facts.map((fact) => fact[field]), "KRW"),
    source,
  };
}

/**
 * strategy aggregate snapshot과 per-market snapshot이 함께 있을 때 합산 대상을 하나로 정규화한다.
 *
 * `market=null` snapshot은 해당 strategy의 전체 시장 합계다. 같은 strategy의 per-market snapshot을 함께 더하면 손익이
 * 이중 집계되므로 aggregate snapshot을 우선하고 세부 market snapshot은 리포트 합산에서 제외한다. 이 함수는 집계 입력만
 * 정규화하며 DB row나 원본 fact를 수정하지 않는다.
 */
function excludeMarketSnapshotsCoveredByAggregate(
  snapshots: readonly DailyReportPnlSnapshotFact[],
): DailyReportPnlSnapshotFact[] {
  const strategiesWithAggregateSnapshot = new Set(
    snapshots
      .filter((snapshot) => snapshot.market === null || snapshot.market === undefined)
      .map((snapshot) => snapshot.strategyId),
  );

  return snapshots.filter(
    (snapshot) =>
      snapshot.market === null ||
      snapshot.market === undefined ||
      !strategiesWithAggregateSnapshot.has(snapshot.strategyId),
  );
}

/**
 * PnL snapshot과 position fallback을 scope별로 합성한다.
 *
 * snapshot이 하나라도 있다는 이유로 전체 positions fallback을 버리면 부분 수집 장애가 손익 누락으로 이어진다. 이 함수는
 * strategy/market scope에 snapshot이 있는 곳은 snapshot을 쓰고, 없는 scope만 positions current snapshot을 fallback으로
 * 보강한다. aggregate snapshot과 market snapshot의 중복 제거는 호출 전 단계에서 끝나 있어야 하며, 외부 side effect는 없다.
 */
function createPnlSource(
  snapshots: readonly DailyReportPnlSnapshotFact[],
  positions: readonly DailyReportPositionFact[],
): {
  facts: readonly (DailyReportPnlSnapshotFact | DailyReportPositionFact)[];
  realizedSource: string;
  estimatedSource: string;
} {
  const snapshotCoverage = createPnlSnapshotCoverage(snapshots);
  const fallbackPositions = positions.filter((position) => !snapshotCoverage.coversPosition(position));
  const facts = [...snapshots, ...fallbackPositions].sort(comparePnlFactScope);
  const hasSnapshots = snapshots.length > 0;
  const hasFallbackPositions = fallbackPositions.length > 0;

  if (hasSnapshots && hasFallbackPositions) {
    return {
      facts,
      realizedSource: "pnl_snapshots+positions",
      estimatedSource: "pnl_snapshots.unrealized_pnl+positions.unrealized_pnl",
    };
  }

  if (hasSnapshots) {
    return {
      facts,
      realizedSource: "pnl_snapshots",
      estimatedSource: "pnl_snapshots.unrealized_pnl",
    };
  }

  return {
    facts,
    realizedSource: "positions",
    estimatedSource: "positions.unrealized_pnl",
  };
}

/**
 * snapshot이 존재하는 PnL scope를 빠르게 판정하는 coverage helper를 만든다.
 *
 * market이 null인 snapshot은 해당 strategy의 전체 시장 합계를 의미하므로 같은 strategy의 position fallback을 모두 막는다.
 * market이 있는 snapshot은 동일 strategy+market position만 대체한다.
 */
function createPnlSnapshotCoverage(snapshots: readonly DailyReportPnlSnapshotFact[]): {
  coversPosition(position: DailyReportPositionFact): boolean;
} {
  const strategiesWithAggregateSnapshot = new Set<string>();
  const marketsByStrategy = new Map<string, Set<string>>();

  for (const snapshot of snapshots) {
    if (snapshot.market === null || snapshot.market === undefined) {
      // strategy aggregate snapshot과 per-market position을 함께 더하면 같은 손익이 중복될 수 있어 strategy 전체를 덮는다.
      strategiesWithAggregateSnapshot.add(snapshot.strategyId);
      continue;
    }

    const markets = marketsByStrategy.get(snapshot.strategyId) ?? new Set<string>();
    markets.add(snapshot.market);
    marketsByStrategy.set(snapshot.strategyId, markets);
  }

  return {
    coversPosition(position) {
      return (
        strategiesWithAggregateSnapshot.has(position.strategyId) ||
        (marketsByStrategy.get(position.strategyId)?.has(position.market) ?? false)
      );
    },
  };
}

/**
 * 기준일 안의 PnL snapshot을 strategy+market 범위별 최신 값 하나로 압축한다.
 *
 * PnL 시계열은 같은 전략/마켓에 여러 row가 쌓일 수 있다. 모두 합산하면 같은 손익이 여러 번 반영되므로, 리포트는 각 범위의
 * 마지막 snapshot만 사용한다. 이 함수는 순수 선택 로직이며 DB 상태를 변경하지 않는다.
 */
function selectLatestPnlSnapshots(
  snapshots: readonly DailyReportPnlSnapshotFact[],
): DailyReportPnlSnapshotFact[] {
  const latestByScope = new Map<string, Map<string | null, DailyReportPnlSnapshotFact>>();

  for (const snapshot of snapshots) {
    const marketKey = snapshot.market ?? null;
    const latestByMarket = latestByScope.get(snapshot.strategyId) ?? new Map<string | null, DailyReportPnlSnapshotFact>();
    const existing = latestByMarket.get(marketKey);
    if (existing === undefined || comparePnlSnapshotCandidate(snapshot, existing) > 0) {
      // strategy와 market을 문자열로 합치면 구분자 충돌이 손익 scope를 섞을 수 있어 중첩 Map으로 정확히 분리한다.
      latestByMarket.set(marketKey, snapshot);
    }
    latestByScope.set(snapshot.strategyId, latestByMarket);
  }

  return [...latestByScope.values()].flatMap((latestByMarket) => [...latestByMarket.values()]).sort(compareSnapshotScope);
}

/**
 * 같은 scope의 PnL snapshot 후보 우선순위를 비교한다.
 *
 * `captured_at`이 다르면 최신 timestamp가 우선이다. timestamp까지 같으면 DB schema에 row id나 created_at이 없으므로,
 * snapshot 내용을 정규화한 canonical key로 tie-break한다. 이 선택은 경제적 우열을 뜻하지 않고, 같은 입력 집합에서 조회 순서가
 * 달라도 항상 같은 row를 고르기 위한 deterministic fallback이다.
 */
function comparePnlSnapshotCandidate(
  left: DailyReportPnlSnapshotFact,
  right: DailyReportPnlSnapshotFact,
): number {
  const leftTime = toTime(left.capturedAt);
  const rightTime = toTime(right.capturedAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return createPnlSnapshotTieBreakKey(left).localeCompare(createPnlSnapshotTieBreakKey(right));
}

/**
 * PnL snapshot 동점 비교에 쓰는 canonical content key를 만든다.
 *
 * Decimal 문자열은 storage scale 차이로 key가 달라지지 않게 정규화한다. scope와 timestamp가 같은 충돌 상황에서만 사용하며,
 * 외부 side effect 없이 tie-break 순서를 안정화한다.
 */
function createPnlSnapshotTieBreakKey(snapshot: DailyReportPnlSnapshotFact): string {
  return JSON.stringify([
    snapshot.strategyId,
    snapshot.market ?? null,
    toTime(snapshot.capturedAt).toString(),
    normalizeDecimalForKey(snapshot.equity),
    normalizeDecimalForKey(snapshot.realizedPnl),
    normalizeDecimalForKey(snapshot.unrealizedPnl),
    normalizeDecimalForKey(snapshot.drawdownBps),
  ]);
}

/**
 * Decimal 문자열을 tie-break key에 넣을 표준 표현으로 정규화한다.
 */
function normalizeDecimalForKey(value: string): string {
  return parseFinancialDecimal(value).toFixed();
}

/**
 * 체결 수수료를 통화별로 합산한다.
 *
 * fee currency가 섞인 값을 하나의 숫자로 합치면 실제 비용 의미가 깨진다. 따라서 통화별 합계를 유지하고, 비용 비중 계산은
 * 별도 함수에서 KRW 단일 통화일 때만 허용한다.
 */
function summarizeFees(fills: readonly DailyReportFillFact[]): DailyReportFeeTotal[] {
  const totals = new Map<string, string[]>();
  for (const fill of fills) {
    const values = totals.get(fill.feeCurrency) ?? [];
    values.push(fill.fee);
    totals.set(fill.feeCurrency, values);
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => ({
      currency,
      amount: sumDecimalStrings(values),
    }));
}

/**
 * 체결 가격과 수량으로 기준일 체결 명목 금액을 계산한다.
 *
 * 현재 MVP universe는 KRW spot이므로 리포트에서는 KRW notional로 표시한다. 체결 row가 없으면 실제 0 거래와 결측을 구분하기
 * 위해 이 metric은 unavailable로 남기고, 거래 횟수만 0으로 표시한다.
 */
function summarizeFillNotional(fills: readonly DailyReportFillFact[]): DailyReportDecimalMetric {
  if (fills.length === 0) {
    return unavailableMetric("KRW");
  }

  const notionals = fills.map((fill) =>
    parseFinancialDecimal(fill.price).mul(parseFinancialDecimal(fill.quantity)).toFixed(),
  );
  return sumMetric(notionals, "KRW");
}

/**
 * 수수료가 체결 명목 금액에서 차지하는 비중을 bps로 계산한다.
 *
 * 이 값은 fee currency가 KRW 하나이고 체결 명목 금액이 양수일 때만 의미가 있다. 통화가 섞이거나 체결이 없으면 잘못된 비용
 * 비중을 보여주지 않기 위해 unavailable을 반환한다.
 */
function calculateFeeToFillNotionalBps(
  feeTotals: readonly DailyReportFeeTotal[],
  totalFillNotional: DailyReportDecimalMetric,
): DailyReportDecimalMetric {
  if (!totalFillNotional.available || totalFillNotional.value === null) {
    return unavailableMetric("bps");
  }

  const krwFee = feeTotals.find((fee) => fee.currency === "KRW");
  if (krwFee === undefined || feeTotals.length !== 1) {
    return unavailableMetric("bps");
  }

  const denominator = parseFinancialDecimal(totalFillNotional.value);
  if (denominator.isZero()) {
    return unavailableMetric("bps");
  }

  return {
    value: parseFinancialDecimal(krwFee.amount).div(denominator).mul(10_000).toFixed(),
    available: true,
    sampleCount: 1,
    unit: "bps",
  };
}

/**
 * 주문 후보 폐기 audit event를 reason code별로 집계한다.
 *
 * audit_events에는 알림, 상태 전이, 운영 기록이 함께 들어오므로 `ORDER_CANDIDATE_DISCARDED` kind만 집계해야 한다. 이 필터를
 * 유지해야 리포트의 폐기 후보 수가 일반 감사 로그 때문에 부풀지 않는다.
 */
function summarizeDiscardedCandidates(
  auditEvents: readonly DailyReportAuditEventFact[],
): DailyReportAggregate["discardedCandidates"] {
  const reasonCodes: string[] = [];
  for (const event of auditEvents) {
    // 주문 후보 폐기는 ORDER_DECISION event 중에서도 payload audit_kind가 맞는 row만 집계해야 일반 감사 로그가 섞이지 않는다.
    if (event.payloadJson.audit_kind !== "ORDER_CANDIDATE_DISCARDED") {
      continue;
    }

    reasonCodes.push(readString(event.payloadJson.reason_code) ?? "unknown_reason");
  }

  return {
    total: reasonCodes.length,
    byReason: countBy(reasonCodes, labelDiscardReason),
  };
}

/**
 * risk_events를 운영자가 볼 차단 조치와 원인 축으로 나눈다.
 *
 * `action`은 어떤 조치가 취해졌는지, `riskType`은 어떤 종류의 위험이었는지를 설명한다. 두 축을 분리해야 "주문 차단이 몇 번"
 * 과 "스프레드/시세/알림 중 무엇 때문인지"를 각각 확인할 수 있다.
 */
function summarizeRiskEvents(sourceData: DailyReportSourceData): DailyReportAggregate["riskEvents"] {
  return {
    total: sourceData.riskEvents.length,
    byAction: countBy(sourceData.riskEvents.map((event) => event.action), labelRiskAction),
    byRiskType: countBy(sourceData.riskEvents.map((event) => event.riskType), labelRiskType),
  };
}

/**
 * 현재 보유 수량이 양수인 포지션만 open position으로 센다.
 *
 * 포지션 row가 남아 있어도 quantity가 0이면 노출이 없으므로 운영 리포트의 보유 포지션 수에 포함하지 않는다.
 */
function countOpenPositions(positions: readonly DailyReportPositionFact[]): number {
  return positions.filter((position) => parseFinancialDecimal(position.quantity).greaterThan(0)).length;
}

/**
 * 문자열 code 목록을 빈도순 리포트 항목으로 바꾼다.
 *
 * 동일 건수에서는 code 오름차순으로 정렬해 fixture와 운영 재생 결과가 deterministic하게 유지되도록 한다. labeler는 사용자
 * 문구를 먼저 붙이고 원본 code를 추적 정보로 보존하는 역할을 한다.
 */
function countBy(values: readonly string[], labeler: (value: string) => string): DailyReportCountItem[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([leftCode, leftCount], [rightCode, rightCount]) => {
      if (rightCount !== leftCount) {
        return rightCount - leftCount;
      }

      return leftCode.localeCompare(rightCode);
    })
    .map(([code, count]) => ({
      code,
      label: labeler(code),
      count,
    }));
}

/**
 * execution quality fact에서 특정 metric이 존재하는 값만 골라낸다.
 *
 * 슬리피지나 spread 비용은 모든 주문에 존재하지 않을 수 있다. undefined 값을 0으로 취급하면 체결 품질이 과도하게 좋아 보이므로
 * 실제 관측값만 평균 계산에 넘긴다.
 */
function readQualityMetric(
  facts: readonly DailyReportExecutionQualityFact[],
  key: keyof DailyReportExecutionQualityFact,
): string[] {
  const values: string[] = [];
  for (const fact of facts) {
    const value = fact[key];
    if (typeof value === "string") {
      values.push(value);
    }
  }

  return values;
}

/**
 * Decimal 문자열 metric의 산술 평균을 만든다.
 *
 * sample이 없으면 unavailable로 남겨 데이터 결측을 표현한다. 외부 side effect는 없고 Decimal 문자열 정밀도를 유지한다.
 */
function averageMetric(values: readonly string[], unit?: string): DailyReportDecimalMetric {
  if (values.length === 0) {
    return unavailableMetric(unit);
  }

  return {
    value: parseFinancialDecimal(sumDecimalStrings(values)).div(values.length).toFixed(),
    available: true,
    sampleCount: values.length,
    ...(unit === undefined ? {} : { unit }),
  };
}

/**
 * Decimal 문자열 metric의 합계를 만든다.
 *
 * sample이 없으면 unavailable을 반환한다. 거래 횟수처럼 0이 명확한 카운트와 달리 손익/체결 품질 숫자는 결측과 0을 구분해야
 * 하므로 이 정책을 공통화한다.
 */
function sumMetric(values: readonly string[], unit?: string): DailyReportDecimalMetric {
  if (values.length === 0) {
    return unavailableMetric(unit);
  }

  return {
    value: sumDecimalStrings(values),
    available: true,
    sampleCount: values.length,
    ...(unit === undefined ? {} : { unit }),
  };
}

/**
 * 값이 없는 metric을 리포트 모델의 공통 unavailable 형태로 만든다.
 */
function unavailableMetric(unit?: string): DailyReportDecimalMetric {
  return {
    value: null,
    available: false,
    sampleCount: 0,
    ...(unit === undefined ? {} : { unit }),
  };
}

/**
 * Decimal 문자열 배열을 정밀도 손실 없이 합산한다.
 */
function sumDecimalStrings(values: readonly string[]): string {
  return values.reduce((sum, value) => sum.add(parseFinancialDecimal(value)), parseFinancialDecimal("0")).toFixed();
}

/**
 * 여러 timestamp 중 최신 값을 ISO 문자열로 반환한다.
 *
 * latest PnL snapshot 추적용이며, 입력이 없으면 optional field를 생략할 수 있게 undefined를 반환한다.
 */
function latestTimestamp(values: readonly unknown[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  let latest = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    latest = Math.max(latest, toTime(value));
  }

  return new Date(latest).toISOString();
}

/**
 * Date 또는 ISO timestamp 입력을 epoch millis로 정규화한다.
 *
 * 잘못된 timestamp는 리포트 window와 최신 snapshot 선택을 오염시키므로 즉시 예외로 실패시킨다.
 */
function toTime(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("daily report timestamp input must be valid");
  }

  return date.getTime();
}

/**
 * latest PnL snapshot 목록을 deterministic한 scope 순서로 정렬한다.
 */
function compareSnapshotScope(left: DailyReportPnlSnapshotFact, right: DailyReportPnlSnapshotFact): number {
  const strategyComparison = left.strategyId.localeCompare(right.strategyId);
  if (strategyComparison !== 0) {
    return strategyComparison;
  }

  return compareOptionalMarket(left.market ?? null, right.market ?? null);
}

/**
 * PnL fact를 strategy/market scope 기준으로 정렬한다.
 *
 * snapshot과 position fallback을 섞어도 집계 source와 테스트 fixture가 입력 순서에 의존하지 않도록 scope 순서를 고정한다.
 */
function comparePnlFactScope(
  left: DailyReportPnlSnapshotFact | DailyReportPositionFact,
  right: DailyReportPnlSnapshotFact | DailyReportPositionFact,
): number {
  const strategyComparison = left.strategyId.localeCompare(right.strategyId);
  if (strategyComparison !== 0) {
    return strategyComparison;
  }

  return compareOptionalMarket(left.market ?? null, right.market ?? null);
}

/**
 * PnL snapshot market scope를 null과 실제 market 문자열로 구분해 정렬한다.
 *
 * null은 전체 시장 범위 snapshot을 뜻하므로 `"ALL"` 같은 실제 market code와 합치지 않는다. 이 비교는 표시 순서만 정하고
 * 손익 선택에는 side effect를 만들지 않는다.
 */
function compareOptionalMarket(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }

  return left.localeCompare(right);
}

/**
 * JSON payload에서 비어 있지 않은 문자열만 리포트 집계 key로 읽는다.
 */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
