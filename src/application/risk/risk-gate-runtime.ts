import { evaluateRiskGate } from "./risk-gate.js";
import { createRiskGateAuditEvents } from "./risk-gate-runtime/audit-event-mapper.js";
import { shouldCreateStrategyPauseActionPlan } from "./risk-gate-runtime/fail-closed-policy.js";
import { appendFailClosedEvaluations, applyRuntimeFailClosedEvaluations } from "./risk-gate-runtime/fail-closed-policy.js";
import { createIllegalRiskGateOrderStateTransitionEvaluation } from "./risk-gate-runtime/candidate-mismatch.js";
import { createKillSwitchTransition, createRiskOrderStateTransition } from "./risk-gate-runtime/kill-switch-policy.js";
import { createKillSwitchEventAppendInput, createOrderEventAppendInput } from "./risk-gate-runtime/evidence-mapper.js";
import { createRiskEvents } from "./risk-gate-runtime/risk-event-mapper.js";
import {
  createHardStopRuntimeActionPlan,
  createStrategyPauseRuntimeActionPlan,
} from "./risk-gate-runtime/runtime-action-plan.js";
import { assignIfDefined } from "./risk-gate-runtime/payload-mapper.js";
import type {
  CreateRiskGateAuditEventsInput,
  PersistRiskGateRuntimeDecisionResult,
  RiskGateDecisionEvidenceAppendInput,
  RiskGateRuntimeDecisionInput,
  RiskGateRuntimeDecisionPlan,
  RiskGateRuntimeEventPorts,
} from "./risk-gate-runtime/types.js";

export type {
  HardStopRuntimeActionPlan,
  PendingPaperOrderCancelAction,
  PersistedRiskEventSeverity,
  PersistRiskGateRuntimeDecisionResult,
  RiskGateDecisionEvidenceAppendInput,
  RiskGateDecisionEvidenceReceipt,
  RiskGateKillSwitchEventAppendInput,
  RiskGateOrderEventAppendInput,
  RiskGateRiskEventAppendInput,
  RiskGateRuntimeDecisionInput,
  RiskGateRuntimeDecisionPlan,
  RiskGateRuntimeEventPorts,
  RiskGateRuntimeEventStorePort,
  StrategyPauseRuntimeActionPlan,
} from "./risk-gate-runtime/types.js";

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
 *
 * 이 함수는 event store port 하나만 호출하며, 주문 상태 전이·kill switch 전이·risk event·audit event가 같은 원자적
 * persistence 경계로 내려가도록 append input을 구성한다.
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
