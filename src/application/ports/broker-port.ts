import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  MarketCode,
  OrderSubmission,
} from "../../domain/index.js";

/**
 * 주문 실행 adapter가 구현해야 하는 application port다.
 *
 * MVP에서는 PaperBroker가 이 port를 구현하고, future live broker도 같은 contract를 구현한다. CostModel,
 * RiskGate, idempotency 검증은 이 port 호출 전 application layer에서 끝나야 한다.
 */
export interface BrokerPort {
  /** 비용과 리스크 gate를 통과한 주문 제출 요청을 broker에 전달한다. */
  submitOrder(order: OrderSubmission): Promise<BrokerOrder>;
  /** broker가 알고 있는 주문을 취소 요청한다. */
  cancelOrder(orderId: string): Promise<BrokerOrder>;
  /** broker 주문 ID로 단일 주문 상태를 조회한다. */
  getOrder(orderId: string): Promise<BrokerOrder | undefined>;
  /** 전체 또는 특정 market의 open order 목록을 조회한다. */
  listOpenOrders(market?: MarketCode): Promise<readonly BrokerOrder[]>;
  /** 주문 한도와 잔고 불일치 검증에 사용할 broker 잔고 snapshot을 조회한다. */
  getBalances(): Promise<BrokerBalanceSnapshot>;
}
