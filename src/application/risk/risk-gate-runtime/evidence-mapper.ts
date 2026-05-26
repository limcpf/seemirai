import type {
  KillSwitchState,
  OrderLifecycleStatus,
  StateTransitionEventCandidate,
} from "../../../domain/index.js";
import { assignIfDefined } from "./payload-mapper.js";
import type {
  RiskGateKillSwitchEventAppendInput,
  RiskGateOrderEventAppendInput,
  RiskGateRuntimeDecisionInput,
} from "./types.js";

/**
 * 주문 상태 전이 event 후보를 event store append 입력으로 감싼다.
 *
 * correlationId를 함께 보존해 order event, risk event, audit event가 같은 주문 후보에서 나왔음을 추적할 수 있게 한다.
 */
export function createOrderEventAppendInput(
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

/**
 * kill switch 상태 전이 event 후보를 event store append 입력으로 감싼다.
 *
 * 전역 상태 전이는 주문 row와 다른 저장소에 반영될 수 있으므로 combined evidence append 안에서만 전달한다.
 */
export function createKillSwitchEventAppendInput(
  input: RiskGateRuntimeDecisionInput,
  event: StateTransitionEventCandidate<KillSwitchState>,
): RiskGateKillSwitchEventAppendInput {
  const appendInput: RiskGateKillSwitchEventAppendInput = {
    event,
  };

  assignIfDefined(appendInput, "correlationId", input.correlationId);

  return appendInput;
}
