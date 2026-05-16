import type {
  ExchangePolicySnapshot,
  FeePolicy,
  MarketPolicy,
  MarketStatus,
  OrderRulePolicy,
} from "../../domain/index.js";
import type { MarketCode } from "../../domain/index.js";

export interface ExchangePolicyPort {
  getMarkets(): Promise<readonly MarketPolicy[]>;
  getMarketStatus(market: MarketCode): Promise<MarketStatus>;
  getOrderRules(market: MarketCode): Promise<OrderRulePolicy>;
  getFees(market: MarketCode): Promise<FeePolicy>;
  getPolicySnapshot(market: MarketCode): Promise<ExchangePolicySnapshot>;
}

