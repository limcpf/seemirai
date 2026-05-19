import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  RegistryActivationConfigSchema,
  defaultRegistryActivationConfig,
} from "./registry-config.js";
import {
  StrategyParametersConfigSchema,
  defaultStrategyParametersConfig,
} from "./strategy-parameters.js";
import { RiskConfigSchema, defaultRiskConfig } from "./risk-config.js";

const defaultConfigUrl = new URL("../../config/paper.json", import.meta.url);

const MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");

export const RuntimeConfigSchema = z
  .object({
    exchange: z.literal("UPBIT").default("UPBIT"),
    market: z.literal("KRW_SPOT").default("KRW_SPOT"),
    mode: z.literal("PAPER_TRADING").default("PAPER_TRADING"),
    live_trading_enabled: z.boolean().default(false),
    withdrawal_enabled: z.boolean().default(false),
    cross_exchange_arbitrage_enabled: z.boolean().default(false),
    futures_enabled: z.boolean().default(false),
    leverage_enabled: z.boolean().default(false),
    market_order_enabled: z.boolean().default(false),
    entry_market_order_enabled: z.boolean().default(false),
    paper_no_key: z.boolean().default(true),
    universe: z
      .object({
        phase_1: z.array(MarketCodeSchema).min(1).default(["KRW-BTC", "KRW-ETH"]),
        auto_include_new_listing: z.boolean().default(false),
        exclude_warning: z.boolean().default(true),
        exclude_caution: z.boolean().default(true),
      })
      .default({
        phase_1: ["KRW-BTC", "KRW-ETH"],
        auto_include_new_listing: false,
        exclude_warning: true,
        exclude_caution: true,
      }),
    llm: z
      .object({
        enabled: z.boolean().default(true),
        can_generate_trade_signal: z.boolean().default(false),
      })
      .default({
        enabled: true,
        can_generate_trade_signal: false,
      }),
    registry: RegistryActivationConfigSchema.default(defaultRegistryActivationConfig),
    strategyParameters: StrategyParametersConfigSchema.default(defaultStrategyParametersConfig),
    risk: RiskConfigSchema.default(defaultRiskConfig),
    secrets: z
      .object({
        upbit_access_key: z.string().min(1).optional(),
        upbit_secret_key: z.string().min(1).optional(),
        telegram_bot_token: z.string().min(1).optional(),
        local_control_token: z.string().min(1).optional(),
      })
      .default({}),
  })
  .strict();

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export class UnsafeRuntimeConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe runtime config: ${violations.join(", ")}`);
    this.name = "UnsafeRuntimeConfigError";
    this.violations = violations;
  }
}

export async function loadDefaultRuntimeConfig(): Promise<RuntimeConfig> {
  return loadRuntimeConfigFile(fileURLToPath(defaultConfigUrl));
}

export async function loadRuntimeConfigFile(filePath: string): Promise<RuntimeConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return loadRuntimeConfig(parsed);
}

export function loadRuntimeConfig(input: unknown): RuntimeConfig {
  const config = RuntimeConfigSchema.parse(input);
  return assertSafeRuntimeConfig(config);
}

export function assertSafeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const violations: string[] = [];

  if (config.live_trading_enabled) {
    violations.push("live_trading_enabled must remain false for MVP");
  }

  if (config.withdrawal_enabled) {
    violations.push("withdrawal_enabled must remain false for MVP");
  }

  if (config.cross_exchange_arbitrage_enabled) {
    violations.push("cross_exchange_arbitrage_enabled must remain false for MVP");
  }

  if (config.futures_enabled || config.leverage_enabled) {
    violations.push("futures and leverage must remain disabled for MVP");
  }

  if (config.market_order_enabled || config.entry_market_order_enabled) {
    violations.push("market orders must remain disabled for MVP");
  }

  if (config.llm.can_generate_trade_signal) {
    violations.push("LLM trade signal generation must remain disabled");
  }

  if (config.mode === "PAPER_TRADING" && !config.paper_no_key) {
    violations.push("paper trading must be able to start without API keys");
  }

  if (violations.length > 0) {
    throw new UnsafeRuntimeConfigError(violations);
  }

  return config;
}
