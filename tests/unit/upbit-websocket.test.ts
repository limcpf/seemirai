import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UPBIT_QUOTATION_WEBSOCKET_URL,
  UpbitQuotationWebSocketClient,
  UpbitWebSocketOrderbookSchema,
  UpbitWebSocketTradeSchema,
  createUpbitOrderbookSubscription,
  createUpbitTradeSubscription,
  decodeUpbitWebSocketMessage,
  replayUpbitWebSocketMessages,
  serializeUpbitWebSocketRequest,
  toMarketDataEvent,
  toOrderbookEvent,
  toTradeEvent,
} from "../../src/infrastructure/upbit/index.js";
import type { MarketDataEvent } from "../../src/domain/index.js";
import type { UpbitWebSocketConnection } from "../../src/infrastructure/upbit/index.js";

const receivedAt = "2026-05-17T02:15:00.000Z";

describe("Upbit WebSocket schemas, client, and replay", () => {
  it("builds public trade and orderbook subscriptions without auth or private paths", () => {
    const tradeSubscription = createUpbitTradeSubscription({
      ticket: "market-data-worker",
      markets: ["KRW-BTC", "KRW-ETH"],
      isOnlyRealtime: true,
    });
    const orderbookSubscription = createUpbitOrderbookSubscription({
      ticket: "market-data-worker",
      markets: [
        {
          market: "KRW-BTC",
          unit: 15,
        },
        {
          market: "KRW-ETH",
        },
      ],
      level: "10000",
    });
    const serialized = [
      serializeUpbitWebSocketRequest(tradeSubscription),
      serializeUpbitWebSocketRequest(orderbookSubscription),
    ].join("\n");

    expect(UPBIT_QUOTATION_WEBSOCKET_URL).toBe("wss://api.upbit.com/websocket/v1");
    expect(tradeSubscription).toEqual([
      { ticket: "market-data-worker" },
      {
        type: "trade",
        codes: ["KRW-BTC", "KRW-ETH"],
        is_only_realtime: true,
      },
      { format: "DEFAULT" },
    ]);
    expect(orderbookSubscription).toEqual([
      { ticket: "market-data-worker" },
      {
        type: "orderbook",
        codes: ["KRW-BTC.15", "KRW-ETH"],
        level: "10000",
      },
      { format: "DEFAULT" },
    ]);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("/private");
  });

  it("sends the subscription after the injected connection opens", () => {
    const sent: string[] = [];
    let openListener: (() => void) | undefined;
    const connection: UpbitWebSocketConnection = {
      readyState: 0,
      send: (data) => sent.push(data),
      close: () => undefined,
      addEventListener: (type, listener) => {
        if (type === "open") {
          openListener = () => listener({});
        }
      },
    };
    const client = new UpbitQuotationWebSocketClient({
      websocketFactory: (url) => {
        expect(url).toBe(UPBIT_QUOTATION_WEBSOCKET_URL);
        return connection;
      },
    });
    const request = client.createTradeSubscription({
      exchangeId: "upbit_krw_spot",
      markets: ["KRW-BTC"],
      consumerId: "market-data-worker",
    });

    client.subscribe(request);
    expect(sent).toEqual([]);

    openListener?.();
    expect(sent).toEqual([serializeUpbitWebSocketRequest(request)]);
  });

  it("parses and maps the trade fixture into a TradeEvent", async () => {
    const payload = UpbitWebSocketTradeSchema.parse(await readJsonFixture("websocket-trade.json"));
    const event = toTradeEvent(payload, { receivedAt });

    expect(event).toMatchObject({
      type: "TRADE",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      tradeId: "17303368620470000",
      price: "100473000",
      quantity: "0.00014208",
      side: "BID",
      exchangeTimestamp: "2024-10-31T01:07:42.047Z",
      receivedAt,
    });
    expect(event.raw).toMatchObject({
      type: "trade",
      code: "KRW-BTC",
      stream_type: "SNAPSHOT",
    });
  });

  it("parses and maps the orderbook fixture into an OrderbookEvent", async () => {
    const payload = UpbitWebSocketOrderbookSchema.parse(await readJsonFixture("websocket-orderbook.json"));
    const event = toOrderbookEvent(payload, { receivedAt });

    expect(event).toMatchObject({
      type: "ORDERBOOK",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      exchangeTimestamp: "2025-05-07T07:06:13.804Z",
      receivedAt,
    });
    expect(event.asks.slice(0, 2)).toEqual([
      {
        price: "137002000",
        size: "0.10623869",
      },
      {
        price: "137023000",
        size: "0.06144079",
      },
    ]);
    expect(event.bids.slice(0, 2)).toEqual([
      {
        price: "137001000",
        size: "0.03656812",
      },
      {
        price: "137000000",
        size: "0.33543284",
      },
    ]);
  });

  it("decodes raw WebSocket text while preserving large sequential_id values", () => {
    const [payload] = decodeUpbitWebSocketMessage(
      '{"type":"trade","code":"KRW-BTC","trade_price":100,"trade_volume":0.01,"ask_bid":"BID","trade_timestamp":1730336862047,"timestamp":1730336862082,"sequential_id":17303368620470000123,"stream_type":"REALTIME"}',
    );

    expect(payload).toMatchObject({
      sequential_id: "17303368620470000123",
    });
    expect(toMarketDataEvent(payload, { receivedAt })).toMatchObject({
      type: "TRADE",
      tradeId: "17303368620470000123",
    });
  });

  it("replays trade and orderbook fixtures as a deterministic event sequence", async () => {
    const events = await collectReplay([
      await readJsonFixture("websocket-trade.json"),
      await readJsonFixture("websocket-orderbook.json"),
    ]);

    expect(events.map((event) => event.type)).toEqual(["TRADE", "ORDERBOOK"]);
    expect(events.map((event) => ("market" in event ? event.market : undefined))).toEqual(["KRW-BTC", "KRW-BTC"]);
  });

  it("emits a stale status event when WebSocket lag exceeds the threshold", async () => {
    const events = await collectReplay(
      [
        {
          payload: await readJsonFixture("websocket-trade.json"),
          receivedAt: "2024-10-31T01:07:45.047Z",
        },
      ],
      {
        receivedAt,
        staleThresholdMs: 1000,
      },
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "STATUS",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      status: "STALE",
      observedAt: "2024-10-31T01:07:45.047Z",
      reasonCode: "upbit_websocket_lag_exceeded",
      websocketLagMs: 3000,
    });
  });

  it("replays reconnect and disconnect lifecycle fixture as status events", async () => {
    const fixture = await readJsonFixture("websocket-lifecycle.json");
    const events = await collectReplay(Array.isArray(fixture) ? fixture : [fixture]);

    expect(events).toEqual([
      {
        type: "STATUS",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        status: "RECONNECTING",
        observedAt: "2026-05-17T02:12:00.000Z",
        reasonCode: "websocket_closed",
        reconnectCount: 1,
      },
      {
        type: "STATUS",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        status: "DISCONNECTED",
        observedAt: "2026-05-17T02:12:30.000Z",
        reasonCode: "idle_timeout",
      },
    ]);
  });

  it("maps Upbit keepalive and error payloads into status events without leaking request secrets", () => {
    expect(toMarketDataEvent({ status: "UP" }, { receivedAt })).toMatchObject({
      type: "STATUS",
      status: "CONNECTED",
      reasonCode: "upbit_websocket_up",
      metadata: {
        upbitStatus: "UP",
      },
    });
    expect(
      toMarketDataEvent(
        {
          error: {
            name: "WRONG_FORMAT",
            message: "요청 형식이 올바르지 않습니다.",
          },
        },
        { receivedAt },
      ),
    ).toMatchObject({
      type: "STATUS",
      status: "DISCONNECTED",
      reasonCode: "upbit_websocket_error:WRONG_FORMAT",
      metadata: {
        errorName: "WRONG_FORMAT",
      },
    });
  });

  it("fails fast on malformed or unknown WebSocket payloads", async () => {
    await expect(
      collectReplay([
        {
          type: "trade",
          code: "KRW-BTC",
        },
      ]),
    ).rejects.toThrow();
  });
});

async function readJsonFixture(filename: string): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "upbit", filename);
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}

async function collectReplay(
  inputs: Iterable<unknown>,
  options: Partial<Parameters<typeof replayUpbitWebSocketMessages>[1]> = {},
): Promise<MarketDataEvent[]> {
  const events: MarketDataEvent[] = [];

  for await (const event of replayUpbitWebSocketMessages(inputs, {
    receivedAt,
    ...options,
  })) {
    events.push(event);
  }

  return events;
}
