import type { JsonRecord, TimestampInput } from "../../domain/index.js";

/**
 * 일간 리포트가 사용하는 고정 업무 시간대다.
 *
 * DB timestamp는 UTC로 유지하지만 운영자는 한국 날짜로 리포트를 읽는다. 따라서 모든 리포트 입력은 이 시간대의
 * `YYYY-MM-DD` 기준일에서 출발해야 하며, 쿼리 경계는 같은 날짜를 UTC half-open window로 변환한 값만 사용한다.
 */
export const dailyReportTimezone = "Asia/Seoul";

/**
 * KST 기준일 하나가 DB에서 조회해야 하는 UTC window로 변환된 값이다.
 *
 * `utcStartAt <= row_timestamp < utcEndAt` 형태의 half-open 조건을 invariant로 유지한다. 이 객체는 DB 조회,
 * Telegram 본문, job payload가 같은 시간 경계를 공유하게 만드는 application contract이며 외부 side effect는 없다.
 */
export interface DailyReportWindow {
  reportDate: string;
  timezone: typeof dailyReportTimezone;
  kstStartAt: string;
  kstEndAt: string;
  utcStartAt: string;
  utcEndAt: string;
}

/**
 * DB 또는 fixture에서 읽어온 주문 row의 리포트 입력 형태다.
 *
 * application layer는 persistence 세부 컬럼명을 알지 않도록 필요한 업무 값만 받는다. `status`는 아직 여러 경계에서
 * 문자열로 들어올 수 있으므로 summary 단계에서 사용자 표시 문구로 변환하고, 원본 값은 metadata 추적용으로만 유지한다.
 */
export interface DailyReportOrderFact {
  status: string;
  strategyId: string;
  market: string;
  requestedNotional: string;
  createdAt: TimestampInput;
}

/**
 * 리포트 비용과 거래 횟수 계산에 필요한 체결 입력이다.
 *
 * `feeCurrency`가 서로 다를 수 있으므로 수수료는 통화별로 분리 집계한다. `price * quantity`는 KRW 마켓의 체결 명목
 * 금액 추정에만 사용하며, 외부 저장소를 변경하지 않는 순수 계산 입력이다.
 */
export interface DailyReportFillFact {
  strategyId?: string;
  market: string;
  side: string;
  price: string;
  quantity: string;
  fee: string;
  feeCurrency: string;
  liquidity: string;
  filledAt: TimestampInput;
}

/**
 * 현재 포지션 snapshot에서 리포트가 읽는 손익 입력이다.
 *
 * `positions`는 시계열이 아니라 현재 상태 snapshot이므로 기준일 안에 변경된 row만 의미한다는 보장을 하지 않는다.
 * 따라서 집계 결과에는 source를 명시해 `pnl_snapshots` 기반 값과 혼동하지 않게 한다.
 */
export interface DailyReportPositionFact {
  strategyId: string;
  market: string;
  quantity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  updatedAt: TimestampInput;
}

/**
 * 전략/마켓별 PnL 시계열 snapshot 입력이다.
 *
 * 하나의 기준일에 여러 snapshot이 들어오면 strategy+market별 최신 snapshot만 리포트 손익에 반영한다. 이 invariant는
 * 같은 전략의 과거 snapshot을 중복 합산해 손익이 부풀려지는 것을 막는다.
 */
export interface DailyReportPnlSnapshotFact {
  strategyId: string;
  market?: string | null;
  capturedAt: TimestampInput;
  equity: string;
  realizedPnl: string;
  unrealizedPnl: string;
  drawdownBps: string;
}

/**
 * 감사 이벤트에서 리포트가 읽는 최소 입력이다.
 *
 * 주문 후보 폐기와 phase 1.5 알트 편입은 `payloadJson.audit_kind`를 기준으로 집계한다. 그 외 감사 이벤트는 알림/운영
 * 추적 metadata로 남길 수 있지만, 이 타입은 DB row를 수정하지 않는 읽기 전용 사실만 표현한다.
 */
export interface DailyReportAuditEventFact {
  eventType: string;
  severity: string;
  payloadJson: JsonRecord;
  occurredAt: TimestampInput;
}

/**
 * 리스크/차단 이벤트에서 리포트가 읽는 최소 입력이다.
 *
 * `action`과 `riskType`은 운영자가 "왜 주문이 막혔는지" 보는 축이다. summary에서는 한국어 사용자 문구를 먼저 보여주고
 * 원본 코드는 하단 metadata와 괄호 표기로만 보존한다.
 */
export interface DailyReportRiskEventFact {
  riskType: string;
  severity: string;
  action: string;
  market?: string | null;
  strategyId?: string | null;
  payloadJson: JsonRecord;
  occurredAt: TimestampInput;
}

/**
 * paper execution과 비용 모델에서 얻은 체결 품질/비용 입력이다.
 *
 * 수수료는 fill에서 확정값으로 집계하지만, 슬리피지와 spread/cancel-requote 비용은 paper simulation 또는 비용 snapshot에만
 * 있을 수 있다. 값이 없으면 리포트는 `unavailable`로 표시해야 하며 임의의 0으로 대체하지 않는다.
 */
export interface DailyReportExecutionQualityFact {
  strategyId: string;
  market: string;
  slippageBps?: string;
  spreadCostBps?: string;
  cancelRequotePenaltyBps?: string;
}

/**
 * 일간 리포트 집계에 필요한 모든 읽기 전용 입력이다.
 *
 * repository, fixture, 향후 worker는 이 구조로 데이터를 넘긴다. 집계 함수는 입력 배열을 변경하지 않고 deterministic한
 * `DailyReportAggregate`만 반환해야 하므로 테스트와 운영 리포트 재생이 같은 결과를 낸다.
 */
export interface DailyReportSourceData {
  orders: readonly DailyReportOrderFact[];
  fills: readonly DailyReportFillFact[];
  positions: readonly DailyReportPositionFact[];
  pnlSnapshots: readonly DailyReportPnlSnapshotFact[];
  auditEvents: readonly DailyReportAuditEventFact[];
  riskEvents: readonly DailyReportRiskEventFact[];
  executionQuality: readonly DailyReportExecutionQualityFact[];
}

/**
 * 이름과 횟수로 표현되는 리포트 집계 항목이다.
 *
 * `code`는 DB/audit 추적용 원본 값이고 `label`은 Telegram이나 사람이 읽는 문구다. 사용자에게는 label을 먼저 보여주며,
 * code는 동일 라벨 충돌이나 사후 조회를 위해 보존한다.
 */
export interface DailyReportCountItem {
  code: string;
  label: string;
  count: number;
}

/**
 * 소수 정밀도를 보존해야 하는 집계 숫자다.
 *
 * JavaScript number로 바꾸지 않고 Decimal 문자열을 유지한다. `sampleCount`는 평균/합계가 실제 관측값에서 왔는지,
 * 아니면 데이터 부재로 `unavailable`인지 구분하는 근거다.
 */
export interface DailyReportDecimalMetric {
  value: string | null;
  available: boolean;
  sampleCount: number;
  unit?: string;
}

/**
 * 통화별 수수료 합계다.
 *
 * 서로 다른 fee currency를 무리하게 합산하지 않기 위해 currency를 key로 분리한다. 비용 비중 계산은 KRW 마켓처럼
 * fill notional과 fee currency가 같은 경우에만 별도 metric으로 제공한다.
 */
export interface DailyReportFeeTotal {
  currency: string;
  amount: string;
}

/**
 * 집계가 완료된 일간 운영 리포트의 application 모델이다.
 *
 * 이 모델은 Telegram 전송, HTTP status 확장, 운영 문서화가 공유할 수 있는 안정적인 중간 결과다. 외부 API 호출이나 DB write
 * side effect는 포함하지 않고, 모든 원본 식별자는 metadata로 내려보낼 수 있게 보존한다.
 */
export interface DailyReportAggregate {
  window: DailyReportWindow;
  orderCount: number;
  fillCount: number;
  openPositionCount: number;
  orderStatusCounts: readonly DailyReportCountItem[];
  realizedPnl: DailyReportDecimalMetric & { source: string };
  estimatedPnl: DailyReportDecimalMetric & { source: string };
  feeTotals: readonly DailyReportFeeTotal[];
  totalFillNotional: DailyReportDecimalMetric;
  feeToFillNotionalBps: DailyReportDecimalMetric;
  averageSlippageBps: DailyReportDecimalMetric;
  averageSpreadCostBps: DailyReportDecimalMetric;
  averageCancelRequotePenaltyBps: DailyReportDecimalMetric;
  discardedCandidates: {
    total: number;
    byReason: readonly DailyReportCountItem[];
  };
  phase15AltApprovals: {
    total: number;
    byAction: readonly DailyReportCountItem[];
    byMarket: readonly DailyReportCountItem[];
  };
  riskEvents: {
    total: number;
    byAction: readonly DailyReportCountItem[];
    byRiskType: readonly DailyReportCountItem[];
  };
  latestPnlSnapshotAt?: string;
}
