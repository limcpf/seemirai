import { describe, expect, it } from "vitest";
import {
  UnsafeRuntimeConfigError,
  loadDefaultRuntimeConfig,
  loadRuntimeNotificationConfig,
  loadRuntimeConfig,
} from "../../src/runtime/index.js";

describe("runtime config", () => {
  it("loads the default paper trading profile without API keys", async () => {
    const config = await loadDefaultRuntimeConfig();

    expect(config.exchange).toBe("UPBIT");
    expect(config.market).toBe("KRW_SPOT");
    expect(config.mode).toBe("PAPER_TRADING");
    expect(config.live_trading_enabled).toBe(false);
    expect(config.withdrawal_enabled).toBe(false);
    expect(config.cross_exchange_arbitrage_enabled).toBe(false);
    expect(config.futures_enabled).toBe(false);
    expect(config.market_order_enabled).toBe(false);
    expect(config.entry_market_order_enabled).toBe(false);
    expect(config.paper_no_key).toBe(true);
    expect(config.secrets.upbit_access_key).toBeUndefined();
    expect(config.universe.phase_1).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(config.strategyParameters.trend_following).toMatchObject({
      max_spread_bps: "8",
      min_depth_krw: "50000000",
      breakout_lookback_buckets: 20,
      min_trade_strength: "1.2",
      min_orderbook_imbalance: "0.08",
      min_volatility_expansion_bps: "18",
      min_candle_momentum_bps: "0",
      min_realized_volatility_bps: "0",
      max_realized_volatility_bps: "100000",
      min_volume_spike_ratio: "0",
      min_trade_direction_imbalance: "0",
      allowed_market_regimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      min_cost_adjusted_margin_bps: "0",
    });
    expect(config.strategyParameters.mean_reversion).toMatchObject({
      max_spread_bps: "6",
      min_depth_krw: "70000000",
      entry_deviation_bps: "25",
      exit_deviation_bps: "8",
      stop_loss_bps: "35",
      min_realized_volatility_bps: "0",
      max_realized_volatility_bps: "100000",
      min_abs_vwap_deviation_bps: "0",
      min_session_liquidity_score: "0",
      allowed_market_regimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      min_cost_adjusted_margin_bps: "0",
    });
    expect(config.strategyParameters.volatility_breakout).toMatchObject({
      max_spread_bps: "8",
      min_depth_krw: "50000000",
      breakout_lookback_buckets: 20,
      min_volatility_expansion_bps: "18",
      min_candle_momentum_bps: "0",
      min_realized_volatility_bps: "0",
      max_realized_volatility_bps: "100000",
      min_volume_spike_ratio: "0",
      allowed_market_regimes: ["trend_up", "trend_down", "range", "volatile", "liquidity_stress"],
      min_cost_adjusted_margin_bps: "0",
    });
    expect(config.strategyParameters.orderbook_imbalance_momentum).toMatchObject({
      max_spread_bps: "7",
      min_depth_krw: "60000000",
      min_trade_strength: "1.25",
      min_orderbook_imbalance: "0.1",
      min_depth_slope_krw_per_bps: "0",
      min_depth_change_rate_ratio: "-1",
      min_trade_direction_imbalance: "0",
      min_cost_adjusted_margin_bps: "0",
    });
    expect(config.strategyParameters.liquidity_reversion).toMatchObject({
      max_spread_bps: "5",
      min_depth_krw: "90000000",
      entry_deviation_bps: "18",
      stop_loss_bps: "30",
      min_depth_change_rate_ratio: "-1",
      min_abs_vwap_deviation_bps: "0",
      min_session_liquidity_score: "0",
      min_cost_adjusted_margin_bps: "0",
    });
    expect(config.risk.thresholds).toEqual({
      daily_loss_limit_bps: "100",
      weekly_loss_limit_bps: "300",
      max_drawdown_bps: "500",
      max_order_notional_bps_of_equity: "100",
      max_expected_loss_bps_of_equity: "20",
      btc_eth_max_position_bps_of_equity: "2000",
      alt_max_position_bps_of_equity: "500",
      total_alt_max_position_bps_of_equity: "1500",
      max_consecutive_strategy_losses: 3,
    });
    expect(config.telegram.provider_timeout_ms).toBe(5000);
  });

  it("fails fast when a config value has the wrong shape", () => {
    expect(() =>
      loadRuntimeConfig({
        exchange: "UPBIT",
        market: "KRW_SPOT",
        mode: "PAPER_TRADING",
        universe: {
          phase_1: ["BTC-KRW"],
        },
      }),
    ).toThrow();
  });

  it("rejects unsafe MVP runtime toggles", () => {
    expect(() =>
      loadRuntimeConfig({
        live_trading_enabled: true,
        withdrawal_enabled: true,
        market_order_enabled: true,
        llm: {
          can_generate_trade_signal: true,
        },
      }),
    ).toThrow(UnsafeRuntimeConfigError);
  });

  it("rejects paper trading profiles that require API keys", () => {
    expect(() =>
      loadRuntimeConfig({
        paper_no_key: false,
      }),
    ).toThrow(UnsafeRuntimeConfigError);
  });

  it("rejects unknown strategy parameter ids and keys", () => {
    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          scalping: {
            max_spread_bps: "1",
          },
        },
      }),
    ).toThrow();

    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          trend_following: {
            max_spread_bps: "8",
            unknown_threshold: "1",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown top-level config keys before defaults hide typos", () => {
    expect(() =>
      loadRuntimeConfig({
        strategy_parameters: {
          trend_following: {
            max_spread_bps: "1",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects wrong threshold types and invalid decimal ranges", () => {
    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          trend_following: {
            max_spread_bps: 8,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          trend_following: {
            min_orderbook_imbalance: "1.2",
          },
        },
      }),
    ).toThrow("must be between 0 and 1");

    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          trend_following: {
            allowed_market_regimes: [],
          },
        },
      }),
    ).toThrow("must include at least one market regime");

    expect(() =>
      loadRuntimeConfig({
        strategyParameters: {
          trend_following: {
            min_trade_direction_imbalance: "1.2",
          },
        },
      }),
    ).toThrow("must be between 0 and 1");

    expect(() =>
      loadRuntimeConfig({
        risk: {
          thresholds: {
            daily_loss_limit_bps: "-1",
          },
        },
      }),
    ).toThrow("must be a non-negative decimal string");
  });

  it("loads Telegram notification config from env without requiring secrets in config files", () => {
    const config = loadRuntimeConfig({
      telegram: {
        chat_id: " config-chat ",
        provider_timeout_ms: 3000,
      },
      secrets: {
        telegram_bot_token: " config-token ",
      },
    });

    expect(loadRuntimeNotificationConfig(config, {})).toEqual({
      telegram: {
        botToken: "config-token",
        chatId: "config-chat",
        providerTimeoutMs: 3000,
      },
    });
    expect(
      loadRuntimeNotificationConfig(config, {
        SEEMIRAI_TELEGRAM_BOT_TOKEN: "env-token",
        SEEMIRAI_TELEGRAM_CHAT_ID: "env-chat",
      }),
    ).toEqual({
      telegram: {
        botToken: "env-token",
        chatId: "env-chat",
        providerTimeoutMs: 3000,
      },
    });
    expect(loadRuntimeNotificationConfig(loadRuntimeConfig({}), {})).toEqual({});
  });

  it("rejects whitespace-only Telegram config values before notifier wiring", () => {
    expect(() =>
      loadRuntimeConfig({
        telegram: {
          chat_id: "   ",
        },
        secrets: {
          telegram_bot_token: "config-token",
        },
      }),
    ).toThrow();

    expect(() =>
      loadRuntimeConfig({
        telegram: {
          chat_id: "config-chat",
        },
        secrets: {
          telegram_bot_token: "   ",
        },
      }),
    ).toThrow();
  });
});
