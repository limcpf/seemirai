import type { AuditEvent, AuditEventReceipt } from "../../ports/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  KillSwitchActionPlan,
  KillSwitchState,
  MarketCode,
  OrderIntent,
  OrderLifecycleStatus,
  RiskBlockAction,
  RiskGateContext,
  RiskGateResult,
  StateTransitionDecision,
  StateTransitionEventCandidate,
  StrategyRiskSnapshot,
  TimestampInput,
} from "../../../domain/index.js";

/**
 * RiskGate evaluation severity를 durable risk event 저장소가 받는 severity 값으로 제한한 타입이다.
 *
 * application 내부의 `BLOCKING` severity는 저장 직전에 `ERROR`로 변환되어야 하며, 이 타입은 DB write 입력 경계의
 * 허용 값만 표현한다.
 */
export type PersistedRiskEventSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

/**
 * RiskGate 평가 실패나 경고를 durable `risk_events` row로 append하기 위한 입력이다.
 *
 * application runtime은 DB schema를 직접 모르고 risk type, action, severity, 주문/전략 식별자, JSON evidence만 port에 넘긴다.
 */
export interface RiskGateRiskEventAppendInput {
  riskType: string;
  action: RiskBlockAction;
  occurredAt: TimestampInput;
  severity: PersistedRiskEventSeverity;
  market?: MarketCode;
  strategyId?: string;
  orderId?: string;
  payloadJson?: JsonRecord;
}

/**
 * RiskGate가 주문 lifecycle state machine 전이를 append하기 위한 입력이다.
 *
 * orderId와 correlationId는 persistence 경계에서 event log와 audit evidence를 같은 주문 후보로 묶기 위해 유지한다.
 */
export interface RiskGateOrderEventAppendInput {
  orderId: string;
  correlationId?: string;
  event: StateTransitionEventCandidate<OrderLifecycleStatus>;
}

/**
 * RiskGate가 전역 kill switch state machine 전이를 append하기 위한 입력이다.
 *
 * kill switch 전이는 주문 event와 다른 durable snapshot을 움직이지만, 같은 evidence append 묶음에 포함돼야 한다.
 */
export interface RiskGateKillSwitchEventAppendInput {
  correlationId?: string;
  event: StateTransitionEventCandidate<KillSwitchState>;
}

/**
 * RiskGate 판단 증거를 한 transaction/outbox 경계에서 저장하기 위한 combined append 입력이다.
 *
 * 주문 상태 전이, kill switch 전이, risk event, audit event를 같은 묶음으로 넘겨 복구 시 상태와 판단 근거가
 * 서로 어긋나지 않도록 한다.
 */
export interface RiskGateDecisionEvidenceAppendInput {
  orderStateTransition: RiskGateOrderEventAppendInput;
  killSwitchStateTransition?: RiskGateKillSwitchEventAppendInput;
  riskEvents: readonly RiskGateRiskEventAppendInput[];
  auditEvents: readonly AuditEvent[];
}

/**
 * RiskGate evidence append가 반환하는 저장 결과 묶음이다.
 *
 * receipt 값의 내부 shape는 persistence 구현체가 소유하므로 runtime은 순서와 원자성만 보존하고 해석하지 않는다.
 */
export interface RiskGateDecisionEvidenceReceipt {
  orderEventReceipt: unknown;
  killSwitchEventReceipt?: unknown;
  riskEventReceipts: readonly unknown[];
  auditEventReceipts: readonly AuditEventReceipt[];
}

/**
 * RiskGate runtime evidence를 원자적으로 저장해야 하는 port다.
 *
 * 구현체는 DB transaction 또는 outbox/idempotency 경계로 이 입력 전체를 append해야 하며, 일부 event만 저장된 상태로
 * 성공을 반환하면 안 된다.
 */
export interface RiskGateRuntimeEventStorePort {
  appendDecisionEvidence(input: RiskGateDecisionEvidenceAppendInput): Promise<RiskGateDecisionEvidenceReceipt>;
}

/**
 * RiskGate runtime이 외부 저장소와 만나는 port 묶음이다.
 *
 * 현재는 eventStore 하나만 갖지만 호출자는 이 객체를 통해 side effect 경계를 명시하고, decision plan 생성 단계와
 * persistence 단계를 분리한다.
 */
export interface RiskGateRuntimeEventPorts {
  eventStore: RiskGateRuntimeEventStorePort;
}

/**
 * RiskGate runtime 판단 계획을 만들기 위한 현재 주문/전역 상태 snapshot이다.
 *
 * orderIntent와 riskGateContext는 서로 대조되어야 하며, currentKillSwitchState는 RiskGate 자체가 모르는 전역 차단 상태를
 * runtime fail-closed 평가로 병합하는 입력이다.
 */
export interface RiskGateRuntimeDecisionInput {
  orderId: string;
  orderStatus: OrderLifecycleStatus;
  /**
   * persistence 경계에서 DB 또는 현재 후보 생성기가 읽은 주문 의도다.
   *
   * RiskGate context의 `orderIntent`와 다시 대조해 stale RiskGate 승인 결과가 다른 주문 금액이나 예상 손실 입력에
   * 재사용되지 않도록 한다.
   */
  orderIntent: OrderIntent;
  /**
   * 현재 주문 후보의 예상 손실 입력이다.
   *
   * RiskGate context가 top-level 예상 손실 값을 쓰는 경우 persistence 경계에서도 같은 값을 비교할 수 있게 한다.
   */
  expectedLossBpsOfEquity?: string;
  currentKillSwitchState: KillSwitchState;
  riskGateContext: RiskGateContext;
  actor: string;
  /**
   * 주문 후보 idempotency/correlation key다.
   *
   * `riskGateContext.orderIntent.idempotencyKey`와 같아야 하며, runtime evidence가 다른 후보의 RiskGate snapshot을
   * 현재 주문에 append하지 못하게 하는 대조 기준으로 사용한다.
   */
  correlationId: string;
  pendingPaperOrders?: readonly BrokerOrder[];
}

/**
 * HARD_STOP 시 취소해야 하는 pending paper order 계획이다.
 *
 * runtime은 이 값을 만든 시점에 broker cancel side effect를 실행하지 않고, evidence 저장 이후 후속 executor가 소비할
 * idempotent 명령 후보만 남긴다.
 */
export interface PendingPaperOrderCancelAction {
  action: "PLAN_CANCEL_PENDING_PAPER_ORDER";
  brokerOrderId: string;
  idempotencyKey: string;
  market: MarketCode;
  status: OrderLifecycleStatus;
}

/**
 * HARD_STOP 전환에 필요한 runtime action plan이다.
 *
 * kill switch 정책 snapshot과 취소 대상 주문 목록을 함께 보존해 audit evidence와 후속 실행이 같은 판단 근거를 공유하게 한다.
 */
export interface HardStopRuntimeActionPlan {
  state: "HARD_STOP";
  actionPlan: KillSwitchActionPlan;
  pendingPaperOrderCancelActions: readonly PendingPaperOrderCancelAction[];
}

/**
 * 특정 전략 평가를 중지하기 위한 runtime action plan이다.
 *
 * 전역 신규 주문 차단 여부와 독립적으로 전략 단위 pause 의도를 표현하며, 생성 자체는 side effect가 없다.
 */
export interface StrategyPauseRuntimeActionPlan {
  action: "PLAN_PAUSE_STRATEGY";
  strategyId: string;
  newOrdersBlocked: false;
  strategyEvaluationBlocked: true;
}

/**
 * RiskGate 재평가 결과를 durable evidence append 직전 형태로 묶은 실행 계획이다.
 *
 * 이 계획은 외부 side effect를 직접 수행하지 않고, event store port와 후속 runtime executor가 소비할 append input과 action plan을
 * 만든다.
 */
export interface RiskGateRuntimeDecisionPlan {
  riskGateResult: RiskGateResult;
  orderStateTransition: StateTransitionDecision<OrderLifecycleStatus>;
  killSwitchStateTransition?: StateTransitionDecision<KillSwitchState>;
  riskEvents: readonly RiskGateRiskEventAppendInput[];
  auditEvents: readonly AuditEvent[];
  hardStopActionPlan?: HardStopRuntimeActionPlan;
  strategyPauseActionPlan?: StrategyPauseRuntimeActionPlan;
}

/**
 * RiskGate decision plan을 저장한 뒤 호출자에게 돌려주는 결과다.
 *
 * 원본 plan과 저장 receipt를 함께 반환해 후속 runtime이 저장된 evidence 기준으로만 action plan을 실행할 수 있게 한다.
 */
export interface PersistRiskGateRuntimeDecisionResult {
  plan: RiskGateRuntimeDecisionPlan;
  orderEventReceipt: unknown;
  killSwitchEventReceipt?: unknown;
  riskEventReceipts: readonly unknown[];
  auditEventReceipts: readonly AuditEventReceipt[];
}

/**
 * audit event mapper가 필요한 RiskGate runtime 판단 입력이다.
 *
 * order transition은 필수이고 kill switch/action plan은 조건부이며, mapper는 이 입력만 읽어 append-only audit event를
 * 생성하고 외부 side effect를 수행하지 않는다.
 */
export interface CreateRiskGateAuditEventsInput {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  riskGateResult: RiskGateResult;
  orderStateTransition: StateTransitionDecision<OrderLifecycleStatus>;
  killSwitchStateTransition?: StateTransitionDecision<KillSwitchState>;
  hardStopActionPlan?: HardStopRuntimeActionPlan;
  strategyPauseActionPlan?: StrategyPauseRuntimeActionPlan;
}

export type { StrategyRiskSnapshot };
