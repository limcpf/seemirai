export const registeredExchangeIds = ["upbit_krw_spot"] as const;
export const registeredStrategyIds = [
  "trend_following",
  "mean_reversion",
  "volatility_breakout",
  "orderbook_imbalance_momentum",
  "liquidity_reversion",
] as const;
export const registeredRuleIds = [
  "universe_allowed",
  "market_warning_absent",
  "spread_ok",
  "depth_sufficient",
  "cost_margin_ok",
  "risk_ok",
  "stop_loss",
  "take_profit",
] as const;

export type RegisteredExchangeId = (typeof registeredExchangeIds)[number];
export type RegisteredStrategyId = (typeof registeredStrategyIds)[number];
export type RegisteredRuleId = (typeof registeredRuleIds)[number];

/**
 * 정적 exchange registry의 단일 entry다.
 *
 * 어떤 exchange id가 어떤 application port 책임을 제공해야 하는지 선언한다. 실제 adapter instance는 후속 runtime
 * 조립 단계에서 연결한다.
 */
export interface ExchangeRegistryEntry {
  id: RegisteredExchangeId;
  marketDataPort: "MarketDataPort";
  policyPort: "ExchangePolicyPort";
  brokerPort: "BrokerPort";
}

/**
 * 정적 strategy registry의 단일 entry다.
 *
 * strategy id, version, 필요한 feature 목록을 config validation과 runtime activation에서 참조한다.
 */
export interface StrategyRegistryEntry {
  id: RegisteredStrategyId;
  version: string;
  requiredFeatures: readonly string[];
}

/**
 * 정적 rule registry의 단일 entry다.
 *
 * rule id와 기본 심각도를 선언해 config가 존재하지 않는 rule을 참조하지 못하게 한다.
 */
export interface RuleRegistryEntry {
  id: RegisteredRuleId;
  defaultSeverity: "BLOCKING" | "EXIT" | "ADVISORY";
}

export const exchangeRegistry: Readonly<Record<RegisteredExchangeId, ExchangeRegistryEntry>> = {
  upbit_krw_spot: {
    id: "upbit_krw_spot",
    marketDataPort: "MarketDataPort",
    policyPort: "ExchangePolicyPort",
    brokerPort: "BrokerPort",
  },
};

export const strategyRegistry: Readonly<Record<RegisteredStrategyId, StrategyRegistryEntry>> = {
  trend_following: {
    id: "trend_following",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "trade_strength",
      "orderbook_imbalance",
      "depth_krw",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
  },
  mean_reversion: {
    id: "mean_reversion",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "depth_krw",
      "mean_reversion_deviation_bps",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
  },
  volatility_breakout: {
    id: "volatility_breakout",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "depth_krw",
      "volatility_expansion_bps",
      "breakout_direction",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
  },
  orderbook_imbalance_momentum: {
    id: "orderbook_imbalance_momentum",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "depth_krw",
      "orderbook_imbalance",
      "trade_strength",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
  },
  liquidity_reversion: {
    id: "liquidity_reversion",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "depth_krw",
      "liquidity_reversion_bps",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
  },
};

export const ruleRegistry: Readonly<Record<RegisteredRuleId, RuleRegistryEntry>> = {
  universe_allowed: {
    id: "universe_allowed",
    defaultSeverity: "BLOCKING",
  },
  market_warning_absent: {
    id: "market_warning_absent",
    defaultSeverity: "BLOCKING",
  },
  spread_ok: {
    id: "spread_ok",
    defaultSeverity: "BLOCKING",
  },
  depth_sufficient: {
    id: "depth_sufficient",
    defaultSeverity: "BLOCKING",
  },
  cost_margin_ok: {
    id: "cost_margin_ok",
    defaultSeverity: "BLOCKING",
  },
  risk_ok: {
    id: "risk_ok",
    defaultSeverity: "BLOCKING",
  },
  stop_loss: {
    id: "stop_loss",
    defaultSeverity: "EXIT",
  },
  take_profit: {
    id: "take_profit",
    defaultSeverity: "EXIT",
  },
};
