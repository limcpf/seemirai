import { describe, expect, it } from "vitest";
import {
  UnsafeRuntimeConfigError,
  loadDefaultRuntimeConfig,
  loadRuntimeConfig,
} from "../../src/runtime/config.js";

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
    expect(config.paper_no_key).toBe(true);
    expect(config.secrets.upbit_access_key).toBeUndefined();
    expect(config.universe.phase_1).toEqual(["KRW-BTC", "KRW-ETH"]);
    expect(config.strategyParameters.trend_following).toMatchObject({
      max_spread_bps: "8",
      min_depth_krw: "50000000",
      breakout_lookback_buckets: 20,
      min_trade_strength: "1.2",
      min_orderbook_imbalance: "0.08",
    });
    expect(config.strategyParameters.mean_reversion).toMatchObject({
      max_spread_bps: "6",
      min_depth_krw: "70000000",
      entry_deviation_bps: "25",
      exit_deviation_bps: "8",
      stop_loss_bps: "35",
    });
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
  });
});
