import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UpbitMarketListResponseSchema,
  UpbitOrderbookInstrumentsResponseSchema,
  UpbitPublicRestClient,
  UpbitRestClientError,
  createUpbitPublicPolicySnapshot,
  createUpbitRateLimitStatus,
  parseRemainingReqHeader,
  toMarketPolicy,
  toMarketStatus,
  toOrderRulePolicy,
  toRestRateLimitPolicy,
  toWebSocketRateLimitPolicy,
} from "../../src/infrastructure/upbit/index.js";

const observedAt = new Date("2026-05-16T16:09:12.000Z");

describe("Upbit public policy schemas and mappers", () => {
  it("parses the market list fixture and normalizes KRW-BTC/KRW-ETH market policies", async () => {
    const markets = UpbitMarketListResponseSchema.parse(await readJsonFixture("market-all-details.json"));

    expect(markets.map((market) => market.market)).toEqual(["KRW-ETH", "KRW-BTC"]);
    expect(markets.map((market) => toMarketPolicy(market, { observedAt }))).toEqual([
      {
        exchangeId: "upbit_krw_spot",
        market: "KRW-ETH",
        baseCurrency: "ETH",
        quoteCurrency: "KRW",
        status: {
          exchangeId: "upbit_krw_spot",
          market: "KRW-ETH",
          tradable: true,
          warning: false,
          caution: false,
          reasonCodes: [],
          updatedAt: observedAt,
        },
      },
      {
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        baseCurrency: "BTC",
        quoteCurrency: "KRW",
        status: {
          exchangeId: "upbit_krw_spot",
          market: "KRW-BTC",
          tradable: true,
          warning: false,
          caution: false,
          reasonCodes: [],
          updatedAt: observedAt,
        },
      },
    ]);
  });

  it("treats any Upbit warning or caution detail as a new-entry block signal", () => {
    const status = toMarketStatus(
      {
        market: "KRW-TEST",
        korean_name: "테스트",
        english_name: "Test",
        market_event: {
          warning: true,
          caution: {
            PRICE_FLUCTUATIONS: false,
            TRADING_VOLUME_SOARING: true,
          },
        },
      },
      { observedAt },
    );

    expect(status).toMatchObject({
      tradable: false,
      warning: true,
      caution: true,
      reasonCodes: ["market_warning", "market_caution:TRADING_VOLUME_SOARING"],
    });
  });

  it("supports the post-2026 caution boolean interpretation without changing domain status", () => {
    const status = toMarketStatus(
      {
        market: "KRW-TEST",
        korean_name: "테스트",
        english_name: "Test",
        market_event: {
          warning: false,
          caution: true,
        },
      },
      { observedAt },
    );

    expect(status).toMatchObject({
      tradable: false,
      warning: false,
      caution: true,
      reasonCodes: ["market_caution:ANY"],
    });
  });

  it("parses orderbook instruments and exposes tick size plus supported levels in order rules", async () => {
    const instruments = UpbitOrderbookInstrumentsResponseSchema.parse(
      await readJsonFixture("orderbook-instruments.json"),
    );
    const btcRules = toOrderRulePolicy(instruments[0]!, {
      observedAt,
      minimumOrderNotional: "5000",
    });

    expect(btcRules).toEqual({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      minimumOrderNotional: "5000",
      priceTickPolicy: {
        kind: "FIXED",
        tickSize: "1000",
      },
      supportedOrderbookLevels: ["0", "10000", "100000", "1000000", "10000000", "100000000"],
      allowedOrderTypes: ["LIMIT", "MARKET"],
      updatedAt: observedAt,
    });
  });

  it("creates a public policy snapshot payload that preserves raw Upbit policy inputs", async () => {
    const markets = UpbitMarketListResponseSchema.parse(await readJsonFixture("market-all-details.json"));
    const instruments = UpbitOrderbookInstrumentsResponseSchema.parse(
      await readJsonFixture("orderbook-instruments.json"),
    );
    const snapshot = createUpbitPublicPolicySnapshot(markets[1]!, instruments[0]!, {
      observedAt,
      minimumOrderNotional: "5000",
      rateLimits: [
        toRestRateLimitPolicy("upbit_krw_spot", parseRemainingReqHeader("group=market; min=600; sec=9")),
      ],
    });

    expect(snapshot).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      marketPolicy: {
        quoteCurrency: "KRW",
        baseCurrency: "BTC",
      },
      orderRules: {
        minimumOrderNotional: "5000",
        supportedOrderbookLevels: ["0", "10000", "100000", "1000000", "10000000", "100000000"],
      },
      orderbookInstrument: {
        tickSize: "1000",
      },
      rateLimits: [
        {
          exchangeId: "upbit_krw_spot",
          group: "REST",
          remaining: 9,
        },
      ],
      raw: {
        market: markets[1],
        orderbookInstrument: instruments[0],
      },
    });
  });

  it("fails fast on malformed Upbit fixtures", () => {
    expect(() =>
      UpbitOrderbookInstrumentsResponseSchema.parse([
        {
          market: "KRW-BTC",
          quote_currency: "KRW",
          supported_levels: ["0"],
        },
      ]),
    ).toThrow();
  });
});

describe("Upbit REST rate limit parsing", () => {
  it("parses Remaining-Req group and per-second remaining count", () => {
    expect(parseRemainingReqHeader("group=market; min=600; sec=9")).toEqual({
      group: "market",
      deprecatedMin: 600,
      sec: 9,
      exhausted: false,
    });
  });

  it("models sec=0 and 429 responses as throttled", () => {
    expect(createUpbitRateLimitStatus(200, parseRemainingReqHeader("group=market; min=600; sec=0"))).toEqual({
      kind: "THROTTLED",
      httpStatus: 429,
      remainingReq: {
        group: "market",
        deprecatedMin: 600,
        sec: 0,
        exhausted: true,
      },
    });
    expect(createUpbitRateLimitStatus(429, parseRemainingReqHeader("group=market; min=600; sec=0"))).toEqual({
      kind: "THROTTLED",
      httpStatus: 429,
      remainingReq: {
        group: "market",
        deprecatedMin: 600,
        sec: 0,
        exhausted: true,
      },
    });
  });

  it("models 418 block responses with retry-after seconds", () => {
    expect(createUpbitRateLimitStatus(418, undefined, 60)).toEqual({
      kind: "BLOCKED",
      httpStatus: 418,
      retryAfterSeconds: 60,
    });
  });

  it("exposes separate REST and WebSocket policy records for scheduler wiring", () => {
    expect(toRestRateLimitPolicy("upbit_krw_spot", parseRemainingReqHeader("group=market; min=600; sec=9"))).toMatchObject({
      exchangeId: "upbit_krw_spot",
      group: "REST",
      remaining: 9,
    });
    expect(toWebSocketRateLimitPolicy("upbit_krw_spot")).toMatchObject({
      exchangeId: "upbit_krw_spot",
      group: "WEBSOCKET",
    });
  });
});

describe("Upbit public REST client", () => {
  it("uses quotation endpoints without credentials and parses response schemas", async () => {
    const requestedUrls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = input.toString();
      requestedUrls.push(url);

      if (url.endsWith("/v1/market/all?is_details=true")) {
        return jsonResponse(await readJsonFixture("market-all-details.json"), "group=market; min=600; sec=9");
      }

      if (url.endsWith("/v1/orderbook/instruments?markets=KRW-BTC%2CKRW-ETH")) {
        return jsonResponse(await readJsonFixture("orderbook-instruments.json"), "group=orderbook; min=600; sec=8");
      }

      throw new Error(`unexpected URL: ${url}`);
    };
    const client = new UpbitPublicRestClient({
      baseUrl: "https://api.upbit.com",
      fetchFn,
    });

    const markets = await client.getMarkets();
    const instruments = await client.getOrderbookInstruments(["KRW-BTC", "KRW-ETH"]);

    expect(requestedUrls).toEqual([
      "https://api.upbit.com/v1/market/all?is_details=true",
      "https://api.upbit.com/v1/orderbook/instruments?markets=KRW-BTC%2CKRW-ETH",
    ]);
    expect(markets.remainingReq).toMatchObject({
      group: "market",
      sec: 9,
    });
    expect(markets.payload.map((market) => market.market)).toEqual(["KRW-ETH", "KRW-BTC"]);
    expect(instruments.remainingReq).toMatchObject({
      group: "orderbook",
      sec: 8,
    });
    expect(instruments.payload.map((instrument) => instrument.market)).toEqual(["KRW-BTC", "KRW-ETH"]);
  });

  it("throws with rate limit status on non-2xx responses", async () => {
    const client = new UpbitPublicRestClient({
      fetchFn: async () =>
        new Response(JSON.stringify({ error: { name: "too_many_requests" } }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "content-type": "application/json",
            "remaining-req": "group=market; min=600; sec=0",
          },
        }),
    });

    await expect(client.getMarkets()).rejects.toMatchObject({
      name: "UpbitRestClientError",
      status: 429,
      rateLimitStatus: {
        kind: "THROTTLED",
        httpStatus: 429,
      },
    } satisfies Partial<UpbitRestClientError>);
  });
});

async function readJsonFixture(fileName: string): Promise<unknown> {
  const raw = await readFile(path.join(process.cwd(), "tests", "fixtures", "upbit", fileName), "utf8");
  return JSON.parse(raw) as unknown;
}

function jsonResponse(payload: unknown, remainingReq: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    statusText: "OK",
    headers: {
      "content-type": "application/json",
      "remaining-req": remainingReq,
    },
  });
}
