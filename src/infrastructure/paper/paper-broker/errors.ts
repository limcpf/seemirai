/**
 * 동일 idempotency key가 서로 다른 주문 후보에 재사용됐을 때 발생하는 broker boundary 오류다.
 *
 * ExecutionEngine은 동시에 들어온 중복 요청만 억제하므로, PaperBroker는 이미 기록된 key가 다른 fingerprint로
 * 들어오면 durable broker state 오염을 막기 위해 side effect 없이 실패시킨다.
 */
export class PaperBrokerIdempotencyConflictError extends Error {
  public readonly idempotencyKey: string;

  public constructor(idempotencyKey: string) {
    super(`Paper broker idempotency key was reused with a different order fingerprint: ${idempotencyKey}`);
    this.name = "PaperBrokerIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * 존재하지 않는 paper 주문을 취소하려고 할 때 발생하는 조회 오류다.
 *
 * BrokerPort는 취소 결과로 `BrokerOrder`를 돌려주므로, 알 수 없는 주문 ID를 조용히 성공 처리하면 runtime이
 * 실제 취소 여부를 오판할 수 있다.
 */
export class PaperBrokerOrderNotFoundError extends Error {
  public readonly brokerOrderId: string;

  public constructor(brokerOrderId: string) {
    super(`Paper broker order was not found: ${brokerOrderId}`);
    this.name = "PaperBrokerOrderNotFoundError";
    this.brokerOrderId = brokerOrderId;
  }
}
