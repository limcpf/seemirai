import {
  getKillSwitchActionPlan,
  transitionKillSwitchState,
  transitionOrderState,
} from "../../domain/index.js";
import { evaluateRiskGate } from "./risk-gate.js";
import type { AuditEvent, AuditEventReceipt } from "../ports/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  KillSwitchActionPlan,
  KillSwitchState,
  MarketCode,
  OrderLifecycleStatus,
  RiskBlockAction,
  RiskEventSeverity,
  RiskGateContext,
  RiskGateEvaluation,
  RiskGateResult,
  StateTransitionDecision,
  StateTransitionEventCandidate,
  StrategyRiskSnapshot,
  TimestampInput,
} from "../../domain/index.js";

export type PersistedRiskEventSeverity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

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

export interface RiskGateOrderEventAppendInput {
  orderId: string;
  correlationId?: string;
  event: StateTransitionEventCandidate<OrderLifecycleStatus>;
}

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

export interface RiskGateRuntimeEventPorts {
  eventStore: RiskGateRuntimeEventStorePort;
}

export interface RiskGateRuntimeDecisionInput {
  orderId: string;
  orderStatus: OrderLifecycleStatus;
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

export interface PendingPaperOrderCancelAction {
  action: "PLAN_CANCEL_PENDING_PAPER_ORDER";
  brokerOrderId: string;
  idempotencyKey: string;
  market: MarketCode;
  status: OrderLifecycleStatus;
}

export interface HardStopRuntimeActionPlan {
  state: "HARD_STOP";
  actionPlan: KillSwitchActionPlan;
  pendingPaperOrderCancelActions: readonly PendingPaperOrderCancelAction[];
}

export interface StrategyPauseRuntimeActionPlan {
  action: "PLAN_PAUSE_STRATEGY";
  strategyId: string;
  newOrdersBlocked: false;
  strategyEvaluationBlocked: true;
}

export interface RiskGateRuntimeDecisionPlan {
  riskGateResult: RiskGateResult;
  orderStateTransition: StateTransitionDecision<OrderLifecycleStatus>;
  killSwitchStateTransition?: StateTransitionDecision<KillSwitchState>;
  riskEvents: readonly RiskGateRiskEventAppendInput[];
  auditEvents: readonly AuditEvent[];
  hardStopActionPlan?: HardStopRuntimeActionPlan;
  strategyPauseActionPlan?: StrategyPauseRuntimeActionPlan;
}

export interface PersistRiskGateRuntimeDecisionResult {
  plan: RiskGateRuntimeDecisionPlan;
  orderEventReceipt: unknown;
  killSwitchEventReceipt?: unknown;
  riskEventReceipts: readonly unknown[];
  auditEventReceipts: readonly AuditEventReceipt[];
}

/**
 * RiskGate 평가 결과를 runtime append-only 저장소에 남길 실행 계획으로 변환한다.
 *
 * 이 함수는 broker cancel 같은 외부 side effect를 호출하지 않는다. HARD_STOP에서도 pending paper order 취소는
 * action plan event로만 남기고, 실제 취소 실행은 M6 ExecutionEngine/PaperBroker 단계가 담당한다.
 */
export function createRiskGateRuntimeDecisionPlan(
  input: RiskGateRuntimeDecisionInput,
): RiskGateRuntimeDecisionPlan {
  // append-only 증거는 현재 snapshot 복구 기준이므로 외부 캐시 결과를 받지 않고 context 기준으로 재평가한다.
  let riskGateResult = applyRuntimeFailClosedEvaluations(input, evaluateRiskGate(input.riskGateContext));
  let orderStateTransition = createRiskOrderStateTransition(input, riskGateResult);
  if (!orderStateTransition.accepted) {
    // RiskGate 승인/거부 결과가 현재 주문 상태와 맞지 않으면 승인 우회가 아니라 별도 리스크로 닫는다.
    riskGateResult = appendFailClosedEvaluations(riskGateResult, [
      createIllegalRiskGateOrderStateTransitionEvaluation(input, orderStateTransition),
    ]);
    orderStateTransition = createRiskOrderStateTransition(input, riskGateResult);
  }
  const killSwitchStateTransition = createKillSwitchTransition(input, riskGateResult);
  const hardStopActionPlan =
    riskGateResult.action === "HARD_STOP"
      ? createHardStopRuntimeActionPlan(input.pendingPaperOrders ?? [])
      : undefined;
  const strategyPauseActionPlan =
    shouldCreateStrategyPauseActionPlan(riskGateResult)
      ? createStrategyPauseRuntimeActionPlan(input.riskGateContext.strategy)
      : undefined;
  const auditEventInput: CreateRiskGateAuditEventsInput = {
    ...input,
    riskGateResult,
    orderStateTransition,
  };
  assignIfDefined(auditEventInput, "killSwitchStateTransition", killSwitchStateTransition);
  assignIfDefined(auditEventInput, "hardStopActionPlan", hardStopActionPlan);
  assignIfDefined(auditEventInput, "strategyPauseActionPlan", strategyPauseActionPlan);
  const auditEvents = createRiskGateAuditEvents(auditEventInput);

  return {
    riskGateResult,
    orderStateTransition,
    riskEvents: createRiskEvents(input, riskGateResult),
    auditEvents,
    ...(killSwitchStateTransition === undefined ? {} : { killSwitchStateTransition }),
    ...(hardStopActionPlan === undefined ? {} : { hardStopActionPlan }),
    ...(strategyPauseActionPlan === undefined ? {} : { strategyPauseActionPlan }),
  };
}

/**
 * RiskGate runtime 계획을 `order_events`, `risk_events`, `audit_events`에 append한다.
 */
export async function persistRiskGateRuntimeDecision(
  ports: RiskGateRuntimeEventPorts,
  input: RiskGateRuntimeDecisionInput,
): Promise<PersistRiskGateRuntimeDecisionResult> {
  const plan = createRiskGateRuntimeDecisionPlan(input);
  const appendInput: RiskGateDecisionEvidenceAppendInput = {
    orderStateTransition: createOrderEventAppendInput(input, plan.orderStateTransition.event),
    riskEvents: plan.riskEvents,
    auditEvents: plan.auditEvents,
  };
  if (plan.killSwitchStateTransition !== undefined) {
    // kill switch 현재 상태도 audit event와 같은 원자적 증거 묶음 안에서 저장되도록 한다.
    assignIfDefined(
      appendInput,
      "killSwitchStateTransition",
      createKillSwitchEventAppendInput(input, plan.killSwitchStateTransition.event),
    );
  }
  const receipt = await ports.eventStore.appendDecisionEvidence(appendInput);

  return {
    plan,
    orderEventReceipt: receipt.orderEventReceipt,
    riskEventReceipts: receipt.riskEventReceipts,
    auditEventReceipts: receipt.auditEventReceipts,
    ...(receipt.killSwitchEventReceipt === undefined
      ? {}
      : { killSwitchEventReceipt: receipt.killSwitchEventReceipt }),
  };
}

/**
 * dominant action이 더 강한 전역 차단으로 승격돼도 strategy pause evidence가 필요한지 판단한다.
 *
 * 연속 손실 초과는 전역 신규 주문 차단과 독립적으로 해당 strategy의 평가 중지 근거가 되므로, 최종 action이
 * `BLOCK_NEW_ORDER`/`MANUAL_REVIEW_REQUIRED`/`HARD_STOP`이어도 failed evaluation에 남은 pause 신호를 보존한다.
 */
function shouldCreateStrategyPauseActionPlan(result: RiskGateResult): boolean {
  return result.failedEvaluations.some((evaluation) => evaluation.action === "PAUSE_STRATEGY");
}

function applyRuntimeFailClosedEvaluations(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): RiskGateResult {
  const failClosedEvaluations = [
    createRuntimeCandidateMismatchEvaluation(input),
    createCurrentKillSwitchBlockingEvaluation(input),
  ].filter((evaluation): evaluation is RiskGateEvaluation => evaluation !== undefined);

  if (failClosedEvaluations.length === 0) {
    return result;
  }

  return appendFailClosedEvaluations(result, failClosedEvaluations);
}

/**
 * runtime에서 발견한 일관성 위반을 RiskGate 실패 평가로 병합한다.
 *
 * RiskGate evaluator 자체가 PASS를 반환했더라도 persistence 경계에서 후보 불일치, kill switch 차단, 불법 상태 전이가
 * 확인되면 현재 주문은 승인하지 않고 같은 evidence 묶음에 실패 원인을 남긴다.
 */
function appendFailClosedEvaluations(
  result: RiskGateResult,
  failClosedEvaluations: readonly RiskGateEvaluation[],
): RiskGateResult {
  if (failClosedEvaluations.length === 0) {
    return result;
  }

  // runtime 경계의 일관성 위반은 RiskGate snapshot이 깨끗해도 주문 승인을 막는다.
  return {
    ...result,
    status: "FAIL",
    approved: false,
    action: selectDominantRiskAction([
      result.action,
      ...failClosedEvaluations.map((evaluation) => evaluation.action),
    ]),
    evaluations: [...result.evaluations, ...failClosedEvaluations],
    failedEvaluations: [...result.failedEvaluations, ...failClosedEvaluations],
  };
}

/**
 * RiskGate 결과와 주문 상태 machine이 충돌한 상황을 fail-closed 리스크 평가로 변환한다.
 */
function createIllegalRiskGateOrderStateTransitionEvaluation(
  input: RiskGateRuntimeDecisionInput,
  transition: StateTransitionDecision<OrderLifecycleStatus>,
): RiskGateEvaluation {
  return {
    status: "FAIL",
    reasonCode: "risk_gate_illegal_order_state_transition",
    message: "RiskGate order state transition is not allowed by the order state machine",
    severity: "CRITICAL",
    action: "MANUAL_REVIEW_REQUIRED",
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      order_id: input.orderId,
      from_state: transition.fromState,
      to_state: transition.toState,
      state_transition_reason_code: transition.reasonCode,
      state_transition_message: transition.message,
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };
}

function createRuntimeCandidateMismatchEvaluation(
  input: RiskGateRuntimeDecisionInput,
): RiskGateEvaluation | undefined {
  const intent = input.riskGateContext.orderIntent;
  const mismatches: JsonRecord = {};
  const intentOrderId = readStringMetadata(intent.metadata, "order_id");

  if (input.correlationId !== intent.idempotencyKey) {
    mismatches.correlation_id = input.correlationId;
    mismatches.order_intent_idempotency_key = intent.idempotencyKey;
  }
  if (intentOrderId !== undefined && intentOrderId !== input.orderId) {
    mismatches.order_id = input.orderId;
    mismatches.order_intent_metadata_order_id = intentOrderId;
  }

  if (Object.keys(mismatches).length === 0) {
    return undefined;
  }

  return {
    status: "FAIL",
    reasonCode: "risk_gate_runtime_candidate_mismatch",
    message: "Runtime order id/correlation identifiers do not match the RiskGate order intent",
    severity: "CRITICAL",
    action: "MANUAL_REVIEW_REQUIRED",
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      order_id: input.orderId,
      order_intent: toOrderIntentPayload(input.riskGateContext),
      mismatches,
    },
  };
}

function createCurrentKillSwitchBlockingEvaluation(
  input: RiskGateRuntimeDecisionInput,
): RiskGateEvaluation | undefined {
  const actionPlan = getKillSwitchActionPlan(input.currentKillSwitchState);

  if (!actionPlan.newOrdersBlocked && !actionPlan.requiresManualReview) {
    return undefined;
  }

  const action = toCurrentKillSwitchRiskAction(input.currentKillSwitchState, actionPlan);

  return {
    status: "FAIL",
    reasonCode: "current_kill_switch_blocks_new_order",
    message: `Current kill switch state blocks new order approval: ${input.currentKillSwitchState}`,
    severity: toCurrentKillSwitchRiskSeverity(action),
    action,
    thresholdSnapshot: input.riskGateContext.thresholdSnapshot,
    metadata: {
      kill_switch_state: input.currentKillSwitchState,
      action_plan: actionPlan,
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };
}

function toCurrentKillSwitchRiskAction(
  state: KillSwitchState,
  actionPlan: KillSwitchActionPlan,
): RiskBlockAction {
  if (state === "HARD_STOP") {
    return "HARD_STOP";
  }
  if (state === "MANUAL_REVIEW_REQUIRED" || actionPlan.requiresManualReview) {
    return "MANUAL_REVIEW_REQUIRED";
  }
  if (state === "STRATEGY_PAUSED") {
    return "PAUSE_STRATEGY";
  }

  return "BLOCK_NEW_ORDER";
}

function toCurrentKillSwitchRiskSeverity(action: RiskBlockAction): RiskEventSeverity {
  return action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "BLOCKING";
}

function selectDominantRiskAction(actions: readonly RiskBlockAction[]): RiskBlockAction {
  return actions.reduce((selected, action) =>
    riskActionPriority[action] > riskActionPriority[selected] ? action : selected,
  );
}

const riskActionPriority: Readonly<Record<RiskBlockAction, number>> = {
  ALLOW: 0,
  PAUSE_STRATEGY: 1,
  BLOCK_NEW_ORDER: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};

function createRiskOrderStateTransition(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): StateTransitionDecision<OrderLifecycleStatus> {
  const toState: OrderLifecycleStatus = result.approved ? "RISK_APPROVED" : "RISK_REJECTED";

  return transitionOrderState({
    fromState: input.orderStatus,
    toState,
    occurredAt: input.riskGateContext.observedAt,
    reasonCode: result.approved ? "risk_gate_order_approved" : "risk_gate_order_rejected",
    message: result.approved
      ? "RiskGate approved order candidate"
      : "RiskGate rejected order candidate",
    metadata: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
  });
}

function createKillSwitchTransition(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): StateTransitionDecision<KillSwitchState> | undefined {
  const targetState = selectTargetKillSwitchState(input.currentKillSwitchState, result.action);

  if (targetState === input.currentKillSwitchState) {
    return undefined;
  }

  return transitionKillSwitchState({
    fromState: input.currentKillSwitchState,
    toState: targetState,
    occurredAt: input.riskGateContext.observedAt,
    reasonCode: `risk_gate_${result.action.toLowerCase()}`,
    message: `RiskGate action moves kill switch to ${targetState}`,
    metadata: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
  });
}

function selectTargetKillSwitchState(
  currentState: KillSwitchState,
  action: RiskBlockAction,
): KillSwitchState {
  const targetState = killSwitchStateByAction[action];

  // 이미 더 강한 차단 상태라면 RiskGate 경고나 약한 차단으로 상태를 낮추지 않는다.
  return killSwitchStatePriority[targetState] > killSwitchStatePriority[currentState]
    ? targetState
    : currentState;
}

const killSwitchStateByAction: Readonly<Record<RiskBlockAction, KillSwitchState>> = {
  ALLOW: "NORMAL",
  BLOCK_NEW_ORDER: "NEW_ORDERS_BLOCKED",
  PAUSE_STRATEGY: "NORMAL",
  HARD_STOP: "HARD_STOP",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
};

const killSwitchStatePriority: Readonly<Record<KillSwitchState, number>> = {
  NORMAL: 0,
  NEW_ORDERS_BLOCKED: 1,
  STRATEGY_PAUSED: 2,
  MANUAL_REVIEW_REQUIRED: 3,
  HARD_STOP: 4,
};

function createRiskEvents(
  input: RiskGateRuntimeDecisionInput,
  result: RiskGateResult,
): RiskGateRiskEventAppendInput[] {
  return [...result.failedEvaluations, ...result.warningEvaluations].map((evaluation) => {
    const payloadJson: JsonRecord = {
      evaluation: toRiskGateEvaluationPayload(evaluation),
      risk_gate: createRiskGateDecisionMetadata(result, input.riskGateContext.strategy),
      order_intent: toOrderIntentPayload(input.riskGateContext),
    };
    assignIfDefined(payloadJson, "correlation_id", input.correlationId);

    const event: RiskGateRiskEventAppendInput = {
      riskType: evaluation.reasonCode,
      action: evaluation.action,
      occurredAt: input.riskGateContext.observedAt,
      severity: toPersistedRiskEventSeverity(evaluation.severity),
      market: input.riskGateContext.orderIntent.market,
      strategyId: input.riskGateContext.orderIntent.strategyId,
      orderId: input.orderId,
      payloadJson,
    };

    return event;
  });
}

function toPersistedRiskEventSeverity(severity: RiskEventSeverity): PersistedRiskEventSeverity {
  if (severity === "BLOCKING") {
    return "ERROR";
  }

  return severity;
}

interface CreateRiskGateAuditEventsInput {
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

function createRiskGateAuditEvents(input: CreateRiskGateAuditEventsInput): AuditEvent[] {
  const events: AuditEvent[] = [
    createStateTransitionAuditEvent({
      input,
      event: input.orderStateTransition.event,
      auditKind: "RISK_GATE_ORDER_STATE_TRANSITION",
    }),
  ];

  if (!input.riskGateResult.approved) {
    events.push(createRiskRejectionAuditEvent(input));
  }

  if (input.killSwitchStateTransition !== undefined) {
    events.push(
      createStateTransitionAuditEvent({
        input,
        event: input.killSwitchStateTransition.event,
        auditKind: "RISK_GATE_KILL_SWITCH_STATE_TRANSITION",
      }),
    );
  }

  if (input.hardStopActionPlan !== undefined) {
    events.push(createHardStopActionPlanAuditEvent(input));
  }

  if (input.strategyPauseActionPlan !== undefined) {
    events.push(createStrategyPauseActionPlanAuditEvent(input));
  }

  return events;
}

function createStateTransitionAuditEvent<State extends string>(options: {
  input: {
    orderId: string;
    riskGateContext: RiskGateContext;
    actor: string;
    correlationId?: string;
    riskGateResult: RiskGateResult;
  };
  event: StateTransitionEventCandidate<State>;
  auditKind: string;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "STATE_TRANSITION",
    severity: options.event.accepted ? "INFO" : "WARN",
    occurredAt: options.event.occurredAt,
    actor: options.input.actor,
    reasonCode: options.event.reasonCode,
    orderId: options.input.orderId,
    strategyId: options.input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: options.auditKind,
      state_transition: toStateTransitionPayload(options.event),
      risk_gate: createRiskGateDecisionMetadata(
        options.input.riskGateResult,
        options.input.riskGateContext.strategy,
      ),
    },
  };

  assignIfDefined(event, "correlationId", options.input.correlationId);

  return event;
}

function createRiskRejectionAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  riskGateResult: RiskGateResult;
}): AuditEvent {
  const firstFailure = input.riskGateResult.failedEvaluations[0];
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: toAuditSeverity(input.riskGateResult.action),
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: firstFailure?.reasonCode ?? "risk_gate_rejected",
    orderId: input.orderId,
    strategyId: input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: "RISK_GATE_REJECTION",
      risk_gate: createRiskGateDecisionMetadata(input.riskGateResult, input.riskGateContext.strategy),
      order_intent: toOrderIntentPayload(input.riskGateContext),
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}

function toAuditSeverity(action: RiskBlockAction): NonNullable<AuditEvent["severity"]> {
  return action === "HARD_STOP" || action === "MANUAL_REVIEW_REQUIRED" ? "CRITICAL" : "WARN";
}

function createHardStopRuntimeActionPlan(
  pendingPaperOrders: readonly BrokerOrder[],
): HardStopRuntimeActionPlan {
  const cancelActions = pendingPaperOrders
    .filter((order) => pendingPaperOrderStatusesRequiringCancel.includes(order.status))
    .map((order) => ({
      action: "PLAN_CANCEL_PENDING_PAPER_ORDER" as const,
      brokerOrderId: order.brokerOrderId,
      idempotencyKey: order.idempotencyKey,
      market: order.market,
      status: order.status,
    }));

  return {
    state: "HARD_STOP",
    actionPlan: getKillSwitchActionPlan("HARD_STOP"),
    pendingPaperOrderCancelActions: cancelActions,
  };
}

function createStrategyPauseRuntimeActionPlan(
  strategy: StrategyRiskSnapshot,
): StrategyPauseRuntimeActionPlan {
  return {
    action: "PLAN_PAUSE_STRATEGY",
    strategyId: strategy.strategyId,
    newOrdersBlocked: false,
    strategyEvaluationBlocked: true,
  };
}

const pendingPaperOrderStatusesRequiringCancel: readonly OrderLifecycleStatus[] = [
  "SUBMITTED",
  "ACCEPTED",
  "PARTIALLY_FILLED",
];

function createHardStopActionPlanAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  hardStopActionPlan?: HardStopRuntimeActionPlan;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: "CRITICAL",
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: "hard_stop_action_plan_created",
    orderId: input.orderId,
    strategyId: input.riskGateContext.orderIntent.strategyId,
    metadata: {
      audit_kind: "HARD_STOP_ACTION_PLAN",
      cancel_pending_paper_orders:
        input.hardStopActionPlan?.actionPlan.cancelPendingPaperOrders ?? false,
      auto_liquidate_open_positions:
        input.hardStopActionPlan?.actionPlan.autoLiquidateOpenPositions ?? false,
      requires_manual_review: input.hardStopActionPlan?.actionPlan.requiresManualReview ?? true,
      pending_paper_order_cancel_actions:
        input.hardStopActionPlan?.pendingPaperOrderCancelActions ?? [],
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}

function createStrategyPauseActionPlanAuditEvent(input: {
  orderId: string;
  riskGateContext: RiskGateContext;
  actor: string;
  correlationId?: string;
  riskGateResult: RiskGateResult;
  killSwitchStateTransition?: StateTransitionDecision<KillSwitchState>;
  strategyPauseActionPlan?: StrategyPauseRuntimeActionPlan;
}): AuditEvent {
  const event: AuditEvent = {
    eventType: "RISK_REJECTION",
    severity: "WARN",
    occurredAt: input.riskGateContext.observedAt,
    actor: input.actor,
    reasonCode: "strategy_pause_action_plan_created",
    orderId: input.orderId,
    strategyId: input.riskGateContext.strategy.strategyId,
    metadata: {
      audit_kind: "STRATEGY_PAUSE_ACTION_PLAN",
      strategy_pause_action: input.strategyPauseActionPlan,
      global_new_orders_blocked: input.riskGateResult.action !== "PAUSE_STRATEGY",
      global_kill_switch_unchanged: input.killSwitchStateTransition === undefined,
    },
  };

  assignIfDefined(event, "correlationId", input.correlationId);

  return event;
}

function createOrderEventAppendInput(
  input: RiskGateRuntimeDecisionInput,
  event: StateTransitionEventCandidate<OrderLifecycleStatus>,
): RiskGateOrderEventAppendInput {
  const appendInput: RiskGateOrderEventAppendInput = {
    orderId: input.orderId,
    event,
  };

  assignIfDefined(appendInput, "correlationId", input.correlationId);

  return appendInput;
}

function createKillSwitchEventAppendInput(
  input: RiskGateRuntimeDecisionInput,
  event: StateTransitionEventCandidate<KillSwitchState>,
): RiskGateKillSwitchEventAppendInput {
  const appendInput: RiskGateKillSwitchEventAppendInput = {
    event,
  };

  assignIfDefined(appendInput, "correlationId", input.correlationId);

  return appendInput;
}

function createRiskGateDecisionMetadata(
  result: RiskGateResult,
  strategy: StrategyRiskSnapshot,
): JsonRecord {
  return {
    status: result.status,
    approved: result.approved,
    action: result.action,
    threshold_snapshot: result.thresholdSnapshot,
    strategy_id: strategy.strategyId,
    failed_reason_codes: result.failedEvaluations.map((evaluation) => evaluation.reasonCode),
    warning_reason_codes: result.warningEvaluations.map((evaluation) => evaluation.reasonCode),
  };
}

function toRiskGateEvaluationPayload(evaluation: RiskGateEvaluation): JsonRecord {
  const payload: JsonRecord = {
    status: evaluation.status,
    reason_code: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    action: evaluation.action,
  };

  assignIfDefined(payload, "threshold_snapshot", evaluation.thresholdSnapshot);
  assignIfDefined(payload, "metadata", evaluation.metadata);

  return payload;
}

function toStateTransitionPayload<State extends string>(
  event: StateTransitionEventCandidate<State>,
): JsonRecord {
  const payload: JsonRecord = {
    event_kind: event.eventKind,
    from_state: event.fromState,
    to_state: event.toState,
    accepted: event.accepted,
    reason_code: event.reasonCode,
    message: event.message,
  };

  assignIfDefined(payload, "metadata", event.metadata);

  return payload;
}

function toOrderIntentPayload(context: RiskGateContext): JsonRecord {
  const intent = context.orderIntent;
  const payload: JsonRecord = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    idempotency_key: intent.idempotencyKey,
    reason: intent.reason,
  };

  if (intent.orderType === "LIMIT") {
    payload.requested_price = intent.requestedPrice;
  }

  assignIfDefined(payload, "metadata", intent.metadata);

  return payload;
}

function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

function assignIfDefined<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) {
    Object.assign(target, { [key]: value });
  }
}
