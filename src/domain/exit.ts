import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";
import type { TimeInForce } from "./orders.js";

// ---------------------------------------------------------------------------
// Exit 판단 기본 타입
// ---------------------------------------------------------------------------

/**
 * exit rule의 개별 평가 상태다.
 *
 * - PASS: exit 조건이 충족되지 않아 이 rule은 trigger되지 않았다.
 * - TRIGGERED: exit 조건이 충족되어 포지션 축소/종료가 필요하다.
 * - BLOCKED: 정책 위반 등으로 exit 후보 생성을 차단한다.
 * - UNAVAILABLE: 필수 입력이 누락되어 평가를 수행할 수 없다 (e.g. trailing stop snapshot 없음).
 */
export type ExitRuleEvaluationStatus = "PASS" | "TRIGGERED" | "BLOCKED" | "UNAVAILABLE";

/**
 * exit 판단의 최종 결정 종류다.
 *
 * - HOLD: exit 조건 미충족, 현재 포지션을 유지한다.
 * - REDUCE: 포지션 일부를 축소하며, 남은 포지션이 유의미하게 존재한다.
 * - EXIT: 포지션 전체 종료 의도다. dust 잔량만 남는 경우 dust reason을 별도 evidence로 남긴다.
 * - BLOCK: exit 판단 자체를 할 수 없거나 exit 후보 생성이 차단된 상태다.
 */
export type ExitDecisionKind = "HOLD" | "REDUCE" | "EXIT" | "BLOCK";

/**
 * exit 의도를 REDUCE(부분 축소)와 EXIT(전체 종료)로 구분한다.
 */
export type ExitIntention = "REDUCE" | "EXIT";

// ---------------------------------------------------------------------------
// Exit rule contract
// ---------------------------------------------------------------------------

/**
 * 단일 exit rule 평가 결과의 공통 필드다.
 *
 * exit rule은 외부 side effect 없이 ExitRuleContext만 평가해 이 결과를 반환한다.
 * 내부 reason code와 metadata는 trace/debug 용도로만 쓰고 사용자-facing 문구와 분리한다.
 */
export interface BaseExitRuleEvaluation {
  /** exit rule의 고유 식별자 */
  ruleId: string;
  /** 평가 상태 */
  status: ExitRuleEvaluationStatus;
  /** 내부 reason code. 사용자-facing 문구와 분리해 trace/debug에 사용한다. */
  reasonCode: string;
  /** trace/debug용 한 줄 설명 */
  message: string;
  /** 추적 정보 (threshold snapshot, 식별자 등) */
  metadata?: JsonRecord;
}

/**
 * trigger된 exit rule 평가 결과다.
 *
 * TRIGGERED 상태는 후속 집계가 REDUCE/EXIT 중 하나로 수렴해야 하므로 exitIntention을 반드시 포함한다.
 */
export interface TriggeredExitRuleEvaluation extends BaseExitRuleEvaluation {
  status: "TRIGGERED";
  /** trigger된 exit 의도 */
  exitIntention: ExitIntention;
}

/**
 * trigger되지 않았거나 차단/평가 불가 상태인 exit rule 평가 결과다.
 *
 * PASS/BLOCKED/UNAVAILABLE은 주문 후보 의도를 만들지 않으므로 exitIntention을 가질 수 없다.
 */
export interface NonTriggeredExitRuleEvaluation extends BaseExitRuleEvaluation {
  status: "PASS" | "BLOCKED" | "UNAVAILABLE";
  exitIntention?: never;
}

/**
 * 단일 exit rule의 평가 결과다.
 *
 * status별 discriminated union으로 TRIGGERED에는 exitIntention을 강제하고,
 * 비-trigger 상태에서는 exitIntention 누락을 타입상 보장한다.
 */
export type ExitRuleEvaluation = TriggeredExitRuleEvaluation | NonTriggeredExitRuleEvaluation;

/**
 * exit rule contract.
 *
 * ExitRule은 broker, DB, Upbit client를 호출하지 않고 ExitRuleContext만 평가한다.
 * 외부 side effect가 없는 순수 판단 함수다.
 */
export interface ExitRule {
  /** rule 고유 식별자 */
  id: string;
  /** ExitRuleContext를 받아 단일 evaluation을 반환한다. */
  evaluate(context: ExitRuleContext): ExitRuleEvaluation | Promise<ExitRuleEvaluation>;
}

// ---------------------------------------------------------------------------
// ExitRuleContext — rule이 평가에 사용하는 입력
// ---------------------------------------------------------------------------

/**
 * exit rule이 평가에 사용하는 공통 context다.
 *
 * exit rule은 이 context만 읽고 broker, DB, Upbit client를 호출하지 않는다.
 */
export interface ExitRuleContext {
  /** 거래소 식별자 */
  exchangeId: ExchangeId;
  /** 대상 마켓 */
  market: MarketCode;
  /** 관측 시각 */
  observedAt: TimestampInput;
  /** 전략 식별자 (없으면 빈 문자열) */
  strategyId: string;
  /** 현재 open position snapshot */
  position: ExitPositionSnapshot;
  /** exit 정책 snapshot */
  policySnapshot: ExitPolicySnapshot;
  /**
   * trailing stop 판단에 필요한 peak/anchor snapshot.
   *
   * snapshot이 없으면 trailing stop rule은 추정하지 않고 UNAVAILABLE을 반환해야 한다.
   */
  trailingState?: ExitTrailingState;
  /**
   * 전략이 생성한 exit signal.
   *
   * 없으면 strategy exit rule은 PASS를 반환한다.
   */
  strategyExitSignal?: ExitStrategySignal;
  /** 시간 기반 청산 설정 */
  timeBasedConfig?: ExitTimeBasedConfig;
  /** 리스크 기반 축소 신호 */
  riskReductionSignal?: ExitRiskReductionSignal;
  /** 추가 메타데이터 */
  metadata?: JsonRecord;
}

// ---------------------------------------------------------------------------
// ExitRuleContext 구성 요소
// ---------------------------------------------------------------------------

/**
 * exit 판단 시점의 open position snapshot.
 *
 * quantity가 0이거나 position이 존재하지 않으면 exit intent를 만들지 않는다.
 */
export interface ExitPositionSnapshot {
  /** 포지션이 속한 거래소 식별자 */
  exchangeId: ExchangeId;
  /** 포지션이 속한 마켓 */
  market: MarketCode;
  /** 보유 수량 (Decimal 문자열) */
  quantity: NumericString;
  /** 평균 매수가 */
  averageEntryPrice: NumericString;
  /** 현재 시장가 */
  currentPrice: NumericString;
  /** 미실현 손익 (bps). 양수=이익, 음수=손실 */
  unrealizedPnlBps: NumericString;
  /** 포지션 평가 금액 (KRW) */
  notionalKrw: NumericString;
  /** 매수 시 전략 식별자 */
  strategyId?: string;
  /** 관측 시각 */
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * exit 실행 시 적용할 정책 snapshot.
 *
 * 최소 주문금액, 호가 단위, dust threshold, exit 비용/슬리피지 source를 표현하며
 * entry cost margin과 분리된 exit 전용 evidence로 사용한다.
 */
export interface ExitPolicySnapshot {
  /** 거래소 최소 주문금액 (KRW) */
  minOrderNotional: NumericString;
  /** 호가 단위 */
  tickSize: NumericString;
  /** dust 잔량 threshold (수량 기준). 이 값 이하로 남는 잔량은 "처리 불가 잔량"으로 구분한다. */
  dustThreshold: NumericString;
  /** exit 비용 추정치 (bps). entry 비용 snapshot과 분리된 exit 전용 필드다. */
  exitCostBps: NumericString;
  /** exit 예상 슬리피지 (bps) */
  exitSlippageBps: NumericString;
  /** 정책 출처 (예: "config/paper.json", "upbit_api") */
  source: string;
  /** 캡처 시각 */
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * trailing stop 판단에 필요한 peak/anchor 정보 snapshot.
 *
 * snapshot이 없으면 trailing stop rule은 현재가로 임의 보정하지 않고 UNAVAILABLE을 반환한다.
 */
export interface ExitTrailingState {
  /** 기준가 (peak price, anchor price) */
  anchorPrice: NumericString;
  /** anchor가 관측된 시각 */
  anchorObservedAt: TimestampInput;
  /** trailing 간격 (bps). 현재가가 anchorPrice에서 trailBps 이상 하락하면 trigger된다. */
  trailBps: NumericString;
  metadata?: JsonRecord;
}

/**
 * 전략이 생성한 exit signal의 공통 필드다.
 *
 * 기존 strategy decision flow와 충돌하지 않도록 별도 metadata로 표현하며
 * BUY entry signal과 동시 발생 시 exit 우선순위를 가진다.
 * exchange/market/strategy scope는 현재 ExitRuleContext와 일치해야 한다.
 */
export interface BaseExitStrategySignal {
  /** signal이 적용되는 거래소 식별자. 현재 ExitRuleContext.exchangeId와 일치해야 한다. */
  exchangeId: ExchangeId;
  /** signal이 적용되는 마켓. 현재 ExitRuleContext.market과 일치해야 한다. */
  market: MarketCode;
  /** signal 생성 전략 식별자 */
  strategyId: string;
  /** signal reason code */
  reasonCode: string;
  /** signal 설명 */
  reason: string;
  /** signal 관측 시각 */
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 전략이 생성한 부분 축소 exit signal이다.
 *
 * REDUCE는 후속 주문 수량 계산 근거가 필요하므로 현재 포지션 대비 축소 비율을 필수로 둔다.
 */
export interface ReduceExitStrategySignal extends BaseExitStrategySignal {
  intention: "REDUCE";
  /** 축소 비율 (현재 포지션 대비, 0보다 크고 1보다 작아야 한다) */
  reductionRatio: NumericString;
}

/**
 * 전략이 생성한 전량 청산 exit signal이다.
 *
 * EXIT는 전체 종료 의도이므로 별도 부분 축소 비율을 허용하지 않는다.
 */
export interface FullExitStrategySignal extends BaseExitStrategySignal {
  intention: "EXIT";
  reductionRatio?: never;
}

/**
 * 전략이 생성한 exit signal.
 *
 * REDUCE/EXIT 의도별 discriminated union으로 부분 축소 수량 근거 누락을 타입 단계에서 막는다.
 */
export type ExitStrategySignal = ReduceExitStrategySignal | FullExitStrategySignal;

/**
 * 시간 기반 청산 설정.
 *
 * UTC/KST 기준을 혼합하지 않고 입력 기준 시간을 timezone 필드에 명시한다.
 */
export interface ExitTimeBasedConfig {
  /** 청산 기준 시각 (ISO 8601). 이 시각이 지나면 exit이 trigger된다. */
  deadline: TimestampInput;
  /** 시간 기준. UTC/KST 혼합 방지를 위해 명시한다. */
  timezone: "UTC" | "KST";
  metadata?: JsonRecord;
}

/**
 * 리스크 게이트가 보내는 포지션 축소 신호.
 */
export interface ExitRiskReductionSignal {
  /** 축소 의도 (REDUCE | EXIT) */
  intention: ExitIntention;
  /** signal이 적용되는 거래소 식별자. 현재 ExitRuleContext.exchangeId와 일치해야 한다. */
  exchangeId: ExchangeId;
  /** signal이 적용되는 마켓. 현재 ExitRuleContext.market과 일치해야 한다. */
  market: MarketCode;
  /** signal이 적용되는 전략 식별자. 현재 context/position strategy와 일치해야 한다. */
  strategyId: string;
  /** 축소 비율 (현재 포지션 대비, 0~1) */
  reductionRatio: NumericString;
  /** 축소 이유 code */
  reasonCode: string;
  /** 축소 이유 설명 */
  reason: string;
  /** 신호 관측 시각 */
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

// ---------------------------------------------------------------------------
// ExitDecision — 여러 rule 평가를 집계한 최종 판단
// ---------------------------------------------------------------------------

/**
 * exit rule 평가 결과를 집계한 최종 exit 판단.
 *
 * 여러 exit rule의 평가 결과를 모아 HOLD / REDUCE / EXIT / BLOCK 중 하나로 수렴시킨다.
 * REDUCE와 EXIT의 구분은 dust 잔량을 고려한 최종 의도다.
 */
export interface ExitDecision {
  /** 최종 exit 판단 */
  kind: ExitDecisionKind;
  /** 모든 exit rule의 개별 평가 결과 */
  ruleEvaluations: readonly ExitRuleEvaluation[];
  /** trigger된 rule 평가만 필터링한 목록 */
  triggeredRules: readonly ExitRuleEvaluation[];
  /** blocked 또는 unavailable인 rule 평가 목록 */
  blockedRules: readonly ExitRuleEvaluation[];
  /** 최종 결정의 reason code */
  reasonCode: string;
  /**
   * 사용자-facing 메시지.
   *
   * 내부 code/enum 값을 첫 화면에 노출하지 않고 상태·원인·영향·필요 조치를 한국어로 설명한다.
   */
  userMessage: string;
  /** 추적 정보 (개별 rule threshold snapshot, 식별자) */
  metadata?: JsonRecord;
  /** 관측 시각 */
  observedAt: TimestampInput;
}

// ---------------------------------------------------------------------------
// ExitSizing & ExitPositionScope — 수량/포지션 검증
// ---------------------------------------------------------------------------

/**
 * exit가 적용되는 포지션의 scope 정보다.
 *
 * exit intent 수량이 open position 수량과 market/strategy scope를 넘지 않음을 보장하는 입력이다.
 */
export interface ExitPositionScope {
  /** 대상 마켓 */
  market: MarketCode;
  /** 대상 전략 식별자 */
  strategyId: string;
  /** open position 총 수량 */
  totalQuantity: NumericString;
  /** 관측 시각 */
  observedAt: TimestampInput;
}

/**
 * ExitSizing 판단 결과.
 *
 * open position quantity 초과 여부, dust/min-order 처리 결과를 포함한다.
 * 초과 수량을 Math.min으로 조용히 clamp하지 않고 차단하거나 evidence를 남긴다.
 */
export interface ExitSizing {
  /** 요청된 청산 수량 */
  requestedQuantity: NumericString;
  /** sizing 단계에서 호가 단위와 최소 주문금액 기준으로 검증된 실제 제출 가격 */
  requestedPrice: NumericString;
  /** sizing 후 실제 실행 가능한 청산 수량 */
  executableQuantity: NumericString;
  /**
   * dust 잔량.
   *
   * "실제 0"과 "처리 불가 잔량"을 구분한다. 0보다 크고 dustThreshold 이하면 dust로 처리한다.
   */
  dustQuantity: NumericString;
  /** dust 발생 원인. dust가 없으면 undefined */
  dustReason?: string;
  /** 최소 주문금액 미달 여부 */
  belowMinOrderNotional: boolean;
  /** 최소 주문금액 미달 원인 */
  belowMinOrderReason?: string;
  /** 청산 후 남는 포지션 평가금액이 최소 주문금액 미만인지 여부 */
  remainingBelowMinOrderNotional?: boolean;
  /** 잔여 포지션 최소 주문금액 미달 원인 */
  remainingBelowMinOrderReason?: string;
  /** 요청 수량이 open position을 초과했는지 여부 */
  exceedsPosition: boolean;
  /** 포지션 초과 원인 */
  exceedsPositionReason?: string;
  /** sizing 유효 여부. false면 broker submit 후보로 넘기지 않는다. */
  valid: boolean;
  /** sizing 실패 시 차단 이유 */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// ExitOrderIntent metadata — exit 주문 후보의 metadata 계약
// ---------------------------------------------------------------------------

/**
 * exit 주문 후보가 OrderIntent.metadata에 설정해야 하는 필수 필드 계약.
 *
 * side=SELL, metadata.position_effect=REDUCE|EXIT, exit_reason_code, exit_rule_id,
 * position_scope를 포함해야 exit intent로 인정된다.
 * entry cost margin과 exit 비용 evidence는 분리된다.
 */
export interface ExitOrderIntentMetadata extends JsonRecord {
  /** 포지션 효과: REDUCE(부분 축소) 또는 EXIT(전체 종료) */
  position_effect: ExitIntention;
  /** exit를 trigger한 rule의 reason code */
  exit_reason_code: string;
  /** exit를 trigger한 rule의 식별자 */
  exit_rule_id: string;
  /** 포지션 scope 정보 */
  position_scope: ExitPositionScope;
  /** exit 비용 추정치 (bps). entry cost margin과 분리된 exit 전용 evidence */
  exit_cost_bps?: NumericString;
  /** exit 예상 슬리피지 (bps) */
  exit_slippage_bps?: NumericString;
}

// ---------------------------------------------------------------------------
// ExitOrderIntent — exit 주문 후보의 public contract
// ---------------------------------------------------------------------------

/**
 * exit 주문 후보 intent다.
 *
 * LimitOrderIntent와 호환되되 side는 SELL로 좁히고 metadata는 ExitOrderIntentMetadata를 필수로 둔다.
 * ExecutionEngine이 이 intent를 받아 BrokerPort.submitOrder로 전환하기 전에
 * position_effect, exit_reason_code, exit_rule_id, position_scope가 metadata에
 * 확정되어 있어야 한다.
 */
export interface ExitOrderIntent {
  exchangeId: ExchangeId;
  market: MarketCode;
  strategyId: string;
  /** exit 주문은 항상 SELL이다. BUY exit intent는 허용하지 않는다. */
  side: "SELL";
  orderType: "LIMIT";
  requestedQuantity: NumericString;
  requestedNotional: NumericString;
  idempotencyKey: string;
  reason: string;
  /** 지정가 가격. PaperBroker/LiveBroker가 체결 simulation에 사용한다. */
  requestedPrice: NumericString;
  /** true이면 taker 체결 가능성이 있는 주문을 post-only 조건으로 다룬다. */
  postOnly?: boolean;
  /** 주문 유효 시간 정책. GTC / IOC / FOK / POST_ONLY */
  timeInForce?: TimeInForce;
  /**
   * exit 전용 필수 metadata.
   *
   * position_effect, exit_reason_code, exit_rule_id, position_scope가 타입상 누락될 수 없다.
   */
  metadata: ExitOrderIntentMetadata;
}
