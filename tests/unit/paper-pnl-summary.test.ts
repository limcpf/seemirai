import { describe, expect, it } from "vitest";
import {
  PaperPnlSummaryInvariantError,
  createPaperPnlSummary,
  createUnavailablePaperPnlSummary,
} from "../../src/application/index.js";

describe("Paper PnL summary", () => {
  it("realizes net KRW PnL and total fees for buy then sell fills", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      submittedOrderCount: 2,
      fills: [
        {
          orderId: "buy-1",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.01",
          totalFillNotional: "100000",
          totalFee: "50",
        },
        {
          orderId: "sell-1",
          market: "KRW-BTC",
          side: "SELL",
          filledQuantity: "0.01",
          totalFillNotional: "101000",
          totalFee: "50.5",
        },
      ],
    });

    expect(summary).toMatchObject({
      startingCashKrw: "1000000",
      endingCashKrw: "1000899.5",
      positionMarketValueKrw: "0",
      realizedPnlKrw: "899.5",
      unrealizedPnlKrw: "0",
      totalPnlKrw: "899.5",
      totalReturnBps: "8.995",
      totalFeesKrw: "100.5",
      submittedOrderCount: 2,
      filledOrderCount: 2,
    });
  });

  it("marks open long positions to the provided KRW price", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      fills: [
        {
          orderId: "buy-1",
          market: "KRW-ETH",
          side: "BUY",
          filledQuantity: "2",
          totalFillNotional: "600000",
          totalFee: "300",
        },
      ],
      markPrices: [
        {
          market: "KRW-ETH",
          priceKrw: "301000",
          source: "fixture_last_bid",
        },
      ],
    });

    expect(summary).toMatchObject({
      endingCashKrw: "399700",
      positionMarketValueKrw: "602000",
      realizedPnlKrw: "0",
      unrealizedPnlKrw: "1700",
      totalPnlKrw: "1700",
      totalReturnBps: "17",
      totalFeesKrw: "300",
      submittedOrderCount: 1,
      filledOrderCount: 1,
    });
  });

  it("accumulates partial fills with weighted average cost before realizing PnL", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      fills: [
        {
          orderId: "buy-1",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.01",
          totalFillNotional: "100000",
          totalFee: "50",
        },
        {
          orderId: "buy-2",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.02",
          totalFillNotional: "220000",
          totalFee: "110",
        },
        {
          orderId: "sell-1",
          market: "KRW-BTC",
          side: "SELL",
          filledQuantity: "0.015",
          totalFillNotional: "168000",
          totalFee: "84",
        },
      ],
      markPrices: [
        {
          market: "KRW-BTC",
          priceKrw: "11200000",
        },
      ],
    });

    expect(summary.realizedPnlKrw).toBe("7836");
    expect(summary.positionMarketValueKrw).toBe("168000");
    expect(summary.unrealizedPnlKrw).toBe("7920");
    expect(summary.totalPnlKrw).toBe("15756");
    expect(summary.totalFeesKrw).toBe("244");
  });

  it("keeps MTM-dependent fields null when an open position has no mark price", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      fills: [
        {
          orderId: "buy-1",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.01",
          totalFillNotional: "100000",
          totalFee: "50",
        },
      ],
    });

    expect(summary).toMatchObject({
      endingCashKrw: "899950",
      positionMarketValueKrw: null,
      realizedPnlKrw: "0",
      unrealizedPnlKrw: null,
      totalPnlKrw: null,
      totalReturnBps: null,
      totalFeesKrw: "50",
    });
  });

  it("returns a zero null-safe summary when there are no fills", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      submittedOrderCount: 3,
      fills: [],
    });

    expect(summary).toEqual({
      startingCashKrw: "1000000",
      endingCashKrw: "1000000",
      positionMarketValueKrw: "0",
      realizedPnlKrw: "0",
      unrealizedPnlKrw: "0",
      totalPnlKrw: "0",
      totalReturnBps: "0",
      totalFeesKrw: "0",
      submittedOrderCount: 3,
      filledOrderCount: 0,
    });
  });

  it("rejects sell fills that exceed the open paper position", () => {
    expect(() =>
      createPaperPnlSummary({
        startingCashKrw: "1000000",
        fills: [
          {
            orderId: "sell-1",
            market: "KRW-BTC",
            side: "SELL",
            filledQuantity: "0.01",
            totalFillNotional: "100000",
            totalFee: "50",
          },
        ],
      }),
    ).toThrow(PaperPnlSummaryInvariantError);
  });

  it("creates an unavailable summary when opening cost basis is not known", () => {
    const summary = createUnavailablePaperPnlSummary({
      startingCashKrw: "1000000",
      endingCashKrw: "1099950",
      totalFeesKrw: "50",
      submittedOrderCount: 1,
      filledOrderCount: 1,
    });

    expect(summary).toEqual({
      startingCashKrw: "1000000",
      endingCashKrw: "1099950",
      positionMarketValueKrw: null,
      realizedPnlKrw: null,
      unrealizedPnlKrw: null,
      totalPnlKrw: null,
      totalReturnBps: null,
      totalFeesKrw: "50",
      submittedOrderCount: 1,
      filledOrderCount: 1,
    });
  });

  it("deduplicates filled order count while accumulating split fill rows", () => {
    const summary = createPaperPnlSummary({
      startingCashKrw: "1000000",
      submittedOrderCount: 1,
      fills: [
        {
          orderId: "buy-split-1",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.01",
          totalFillNotional: "100000",
          totalFee: "50",
        },
        {
          orderId: "buy-split-1",
          market: "KRW-BTC",
          side: "BUY",
          filledQuantity: "0.005",
          totalFillNotional: "50000",
          totalFee: "25",
        },
      ],
      markPrices: [
        {
          market: "KRW-BTC",
          priceKrw: "10100000",
        },
      ],
    });

    expect(summary.filledOrderCount).toBe(1);
    expect(summary.totalFeesKrw).toBe("75");
    expect(summary.positionMarketValueKrw).toBe("151500");
    expect(summary.unrealizedPnlKrw).toBe("1425");
  });
});
