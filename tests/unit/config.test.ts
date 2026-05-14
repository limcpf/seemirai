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
});
