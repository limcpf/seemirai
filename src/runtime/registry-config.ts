import { z } from "zod";
import {
  exchangeRegistry,
  registeredExchangeIds,
  registeredRuleIds,
  registeredStrategyIds,
  ruleRegistry,
  strategyRegistry,
} from "../application/index.js";
import type {
  ExchangeRegistryEntry,
  RegisteredRuleId,
  RuleRegistryEntry,
  StrategyRegistryEntry,
} from "../application/index.js";

const RegisteredExchangeIdSchema = z.enum(registeredExchangeIds);
const RegisteredStrategyIdSchema = z.enum(registeredStrategyIds);
const RegisteredRuleIdSchema = z.enum(registeredRuleIds);

const StrategyActivationSchema = z
  .object({
    id: RegisteredStrategyIdSchema,
    enabled: z.boolean().default(true),
    ruleIds: z.array(RegisteredRuleIdSchema).min(1, "strategy rule composition must not be empty"),
  })
  .strict();

export const RegistryActivationConfigSchema = z
  .object({
    exchangeId: RegisteredExchangeIdSchema,
    strategies: z.array(StrategyActivationSchema).min(1, "at least one strategy config is required"),
  })
  .strict()
  .superRefine((config, context) => {
    const seenStrategyIds = new Set<string>();

    for (const [index, strategy] of config.strategies.entries()) {
      if (seenStrategyIds.has(strategy.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["strategies", index, "id"],
          message: `duplicate strategy id: ${strategy.id}`,
        });
      }

      seenStrategyIds.add(strategy.id);
    }
  });

export type RegistryActivationConfig = z.infer<typeof RegistryActivationConfigSchema>;

/**
 * config validation 후 활성화된 단일 strategy 조합이다.
 *
 * disabled strategy를 제외한 뒤, strategy registry entry와 rule registry entry 목록을 runtime이 바로 사용할 수
 * 있게 묶는다.
 */
export interface ResolvedStrategyActivation {
  strategy: StrategyRegistryEntry;
  rules: readonly RuleRegistryEntry[];
}

/**
 * registry activation config를 해석한 결과다.
 *
 * runtime 조립 단계는 이 결과를 기준으로 exchange adapter, strategy worker, rule engine을 연결한다.
 */
export interface RegistryActivationResolution {
  exchange: ExchangeRegistryEntry;
  activeStrategies: readonly ResolvedStrategyActivation[];
}

export const defaultStrategyRuleIds: readonly RegisteredRuleId[] = [
  "universe_allowed",
  "market_warning_absent",
  "spread_ok",
  "depth_sufficient",
  "cost_margin_ok",
  "risk_ok",
  "stop_loss",
  "take_profit",
];

export const defaultRegistryActivationConfig: RegistryActivationConfig = {
  exchangeId: "upbit_krw_spot",
  strategies: [
    {
      id: "trend_following",
      enabled: true,
      ruleIds: [...defaultStrategyRuleIds],
    },
    {
      id: "mean_reversion",
      enabled: true,
      ruleIds: [...defaultStrategyRuleIds],
    },
    {
      id: "volatility_breakout",
      enabled: true,
      ruleIds: [...defaultStrategyRuleIds],
    },
    {
      id: "orderbook_imbalance_momentum",
      enabled: true,
      ruleIds: [...defaultStrategyRuleIds],
    },
    {
      id: "liquidity_reversion",
      enabled: true,
      ruleIds: [...defaultStrategyRuleIds],
    },
  ],
};

export function resolveRegistryActivationConfig(input: unknown): RegistryActivationResolution {
  const config = RegistryActivationConfigSchema.parse(input);

  return {
    exchange: exchangeRegistry[config.exchangeId],
    activeStrategies: config.strategies
      .filter((strategy) => strategy.enabled)
      .map((strategy) => ({
        strategy: strategyRegistry[strategy.id],
        rules: strategy.ruleIds.map((ruleId) => ruleRegistry[ruleId]),
      })),
  };
}
