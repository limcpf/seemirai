import type { BrokerOrder, MarketCode, OrderSubmission } from "../../domain/index.js";

export interface BrokerPort {
  submitOrder(order: OrderSubmission): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<BrokerOrder>;
  getOrder(orderId: string): Promise<BrokerOrder | undefined>;
  listOpenOrders(market?: MarketCode): Promise<readonly BrokerOrder[]>;
}

