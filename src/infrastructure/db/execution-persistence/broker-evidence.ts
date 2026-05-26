import type { PaperFillSimulationResult } from "../../../application/execution/index.js";
import type { BrokerOrder, JsonRecord, NumericString } from "../../../domain/index.js";

/**
 * PaperBroker 취소 metadata에서 persistence 검증에 필요한 최소 evidence만 추린 값이다.
 *
 * `BrokerOrder.metadata`는 JSON 경계라서 DB 저장 전에 구조를 좁혀야 하며, 여기서는 open 수량을 실제로 해소한
 * `canceled_quantity`만 상태/회계 불변식 검증에 사용한다.
 */
export interface PaperCancelEvidence {
  canceledQuantity: NumericString;
}

/**
 * PaperBroker metadata에서 fill simulation evidence를 읽는다.
 *
 * broker metadata는 JSON 입력 경계라 타입 선언만으로 신뢰하지 않고 runtime 구조를 확인한다. 구조가 맞지 않으면
 * undefined를 반환해 호출자가 상태별 fail-closed 검증을 수행하게 한다.
 */
export function readPaperFillSimulation(order: BrokerOrder): PaperFillSimulationResult | undefined {
  const simulation = order.metadata?.paper_fill_simulation;
  if (isPaperFillSimulationResult(simulation)) {
    return simulation;
  }

  return undefined;
}

/**
 * PaperBroker `paper_cancel` JSON에서 취소 수량 evidence를 읽는다.
 *
 * 외부 입력과 같은 JSON metadata는 타입 선언만 믿지 않고 runtime 구조를 확인한다. 구조가 맞지 않으면 evidence가
 * 없는 것으로 취급해 기존 status/quantity 검증이 fail-closed 하도록 둔다.
 */
export function readPaperCancelEvidence(order: BrokerOrder): PaperCancelEvidence | undefined {
  const cancel = order.metadata?.paper_cancel;
  if (!isJsonRecord(cancel)) {
    return undefined;
  }

  const balanceMutation = cancel.balance_mutation;
  if (!isJsonRecord(balanceMutation) || typeof balanceMutation.canceled_quantity !== "string") {
    return undefined;
  }

  return {
    canceledQuantity: balanceMutation.canceled_quantity,
  };
}

function isPaperFillSimulationResult(value: unknown): value is PaperFillSimulationResult {
  if (!isJsonRecord(value) || !Array.isArray(value.fills)) {
    return false;
  }

  return typeof value.status === "string" && typeof value.orderStatus === "string";
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
