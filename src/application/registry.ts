export const registeredExchangeIds = ["upbit_krw_spot"] as const;
export const registeredStrategyIds = ["trend_following", "mean_reversion"] as const;
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

export interface ExchangeRegistryEntry {
  id: RegisteredExchangeId;
  marketDataPort: "MarketDataPort";
  policyPort: "ExchangePolicyPort";
  brokerPort: "BrokerPort";
}

export interface StrategyRegistryEntry {
  id: RegisteredStrategyId;
  version: string;
  requiredFeatures: readonly string[];
}

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
      "depth_sufficient",
      "volatility_regime",
      "trade_strength",
    ],
  },
  mean_reversion: {
    id: "mean_reversion",
    version: "0.1.0",
    requiredFeatures: [
      "spread_bps",
      "orderbook_imbalance",
      "volatility_regime",
      "utc_kst_reset",
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

