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
