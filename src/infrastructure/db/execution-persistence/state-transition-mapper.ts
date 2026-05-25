import type {
  JsonRecord,
  OrderLifecycleStatus,
  StateTransitionEventCandidate,
  TimestampInput,
} from "../../../domain/index.js";
import { transitionOrderState } from "../../../domain/index.js";
import { toStorageDecimalString } from "../../../shared/index.js";
import { readPaperFillSimulation } from "./broker-evidence.js";
import type { PersistPaperExecutionInput } from "./types.js";

/**
 * paper broker 최종 상태를 상태 machine이 허용하는 주문 lifecycle event sequence로 확장한다.
 *
 * broker는 최종 상태만 보고하지만 DB는 append-only 상태 전이를 저장한다. 따라서 RISK_APPROVED에서 broker 최종 상태까지의
 * 합법 전이만 생성하고, state machine이 거부하면 저장 전에 중단한다.
 */
export function createPaperExecutionStateTransitionEvents(
  input: PersistPaperExecutionInput,
): readonly StateTransitionEventCandidate<OrderLifecycleStatus>[] {
  const targetStatuses = createPaperExecutionTargetStatuses(input);
  const events: StateTransitionEventCandidate<OrderLifecycleStatus>[] = [];
  let fromState: OrderLifecycleStatus = "RISK_APPROVED";

  for (const toState of targetStatuses) {
    const decision = transitionOrderState({
      fromState,
      toState,
      occurredAt: selectTransitionTimestamp(toState, input),
      reasonCode: createPaperExecutionReasonCode(fromState, toState),
      message: `Paper execution state transition: ${fromState} -> ${toState}`,
      metadata: createStateTransitionMetadata(input),
    });

    if (!decision.accepted) {
      // 최종 broker 상태를 event log로 못 풀면 DB snapshot과 상태 machine 계약이 어긋난 것이므로 저장을 중단한다.
      throw new Error(`paper execution produced illegal order transition: ${fromState} -> ${toState}`);
    }

    events.push(decision.event);
    fromState = toState;
  }

  return events;
}

function createStateTransitionMetadata(input: PersistPaperExecutionInput): JsonRecord {
  const payload: JsonRecord = {
    source: "paper_execution_persistence",
    broker_order_id: input.brokerOrder.brokerOrderId,
    idempotency_key: input.brokerOrder.idempotencyKey,
    broker_status: input.brokerOrder.status,
    remaining_quantity: toStorageDecimalString(input.brokerOrder.remainingQuantity),
  };
  assignIfDefined(payload, "paper_fill_reason_code", readPaperFillSimulation(input.brokerOrder)?.reasonCode);

  return payload;
}

function createPaperExecutionTargetStatuses(input: PersistPaperExecutionInput): readonly OrderLifecycleStatus[] {
  const finalStatus = input.brokerOrder.status;
  switch (finalStatus) {
    case "SUBMITTED":
      return ["SUBMITTED"];
    case "ACCEPTED":
      return ["SUBMITTED", "ACCEPTED"];
    case "PARTIALLY_FILLED":
      return ["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED"];
    case "FILLED":
      return ["SUBMITTED", "ACCEPTED", "FILLED"];
    case "CANCELED":
      if (hasPaperFills(input)) {
        // IOC 부분체결 후 취소처럼 fill이 있는 취소 주문은 lifecycle event만으로도 부분체결 이력을 복구할 수 있어야 한다.
        return ["SUBMITTED", "ACCEPTED", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "CANCELED"];
      }
      return ["SUBMITTED", "ACCEPTED", "CANCEL_REQUESTED", "CANCELED"];
    case "REJECTED":
      return ["SUBMITTED", "REJECTED"];
    case "EXPIRED":
      return ["SUBMITTED", "ACCEPTED", "EXPIRED"];
    case "FAILED":
      return ["SUBMITTED", "FAILED"];
    case "MANUAL_REVIEW_REQUIRED":
      return ["SUBMITTED", "MANUAL_REVIEW_REQUIRED"];
    default:
      throw new Error(`paper execution final status is not persistable from RISK_APPROVED: ${finalStatus}`);
  }
}

function selectTransitionTimestamp(
  toState: OrderLifecycleStatus,
  input: PersistPaperExecutionInput,
): TimestampInput {
  if (toState === "SUBMITTED") {
    return input.submission.submittedAt;
  }

  if (toState === "ACCEPTED") {
    return input.brokerOrder.acceptedAt ?? input.brokerOrder.updatedAt;
  }

  return input.brokerOrder.updatedAt;
}

function createPaperExecutionReasonCode(
  fromState: OrderLifecycleStatus,
  toState: OrderLifecycleStatus,
): string {
  return `paper_execution_${fromState.toLowerCase()}_to_${toState.toLowerCase()}`;
}

function hasPaperFills(input: PersistPaperExecutionInput): boolean {
  return (readPaperFillSimulation(input.brokerOrder)?.fills.length ?? 0) > 0;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
