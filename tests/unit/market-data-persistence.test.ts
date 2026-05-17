import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  UpbitMarketListResponseSchema,
  UpbitOrderbookInstrumentsResponseSchema,
  UpbitWebSocketOrderbookSchema,
  UpbitWebSocketTradeSchema,
  createUpbitPublicPolicySnapshot,
  parseRemainingReqHeader,
  toOrderbookEvent,
  toPolicySnapshotInput,
  toRestRateLimitPolicy,
  toTradeEvent,
  toTradeRow,
  toOrderbookMetricRow,
  toOrderbookSnapshotRow,
} from "../../src/infrastructure/index.js";

const observedAt = "2026-05-17T07:20:00.000Z";
const receivedAt = "2025-05-07T07:06:14.804Z";
const krwPriceTickPolicy = {
  kind: "PRICE_BANDS",
  bands: [
    {
      minPrice: "0",
      maxPrice: "1000",
      tickSize: "1",
    },
    {
      minPrice: "1000",
      tickSize: "5",
    },
  ],
} as const;

describe("market data persistence mappers", () => {
  it("creates deterministic policy snapshot input with checksum", async () => {
    const markets = UpbitMarketListResponseSchema.parse(await readJsonFixture("market-all-details.json"));
    const instruments = UpbitOrderbookInstrumentsResponseSchema.parse(
      await readJsonFixture("orderbook-instruments.json"),
    );
    const snapshot = createUpbitPublicPolicySnapshot(markets[1]!, instruments[0]!, {
      observedAt,
      capturedAt: observedAt,
      minimumOrderNotional: "5000",
      priceTickPolicy: krwPriceTickPolicy,
      rateLimits: [
        toRestRateLimitPolicy("upbit_krw_spot", parseRemainingReqHeader("group=market; min=600; sec=9")),
      ],
    });
    const input = toPolicySnapshotInput(snapshot);

    expect(input).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      sourceProfile: "PAPER_NO_KEY:UPBIT_PUBLIC_POLICY",
      effectiveAt: observedAt,
      capturedAt: observedAt,
      payloadJson: {
        kind: "upbit_public_policy_snapshot",
        snapshot: {
          market: "KRW-BTC",
          orderRules: {
            minimumOrderNotional: "5000",
          },
        },
      },
    });
    expect(input.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(toPolicySnapshotInput(snapshot).checksum).toBe(input.checksum);
  });

  it("maps WebSocket TradeEvent into trades table row without losing side semantics", async () => {
    const payload = UpbitWebSocketTradeSchema.parse(await readJsonFixture("websocket-trade.json"));
    const event = toTradeEvent(payload, { receivedAt: observedAt });
    const row = toTradeRow(event);

    expect(row).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      trade_id: "17303368620470000",
      side: "BUY",
      price: "100473000",
      volume: "0.00014208",
      exchange_timestamp: "2024-10-31T01:07:42.047Z",
      received_at: observedAt,
      raw_payload_json: {
        type: "trade",
        code: "KRW-BTC",
      },
    });
  });

  it("creates 1 second orderbook metric input from normalized orderbook events", async () => {
    const payload = UpbitWebSocketOrderbookSchema.parse(await readJsonFixture("websocket-orderbook.json"));
    const event = toOrderbookEvent(payload, { receivedAt });
    const row = toOrderbookMetricRow(event);

    expect(row).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      bucket_at: "2025-05-07T07:06:13.000Z",
      best_bid_price: "137001000",
      best_ask_price: "137002000",
      spread_bps: "0.072992",
      bid_depth_1: "0.03656812",
      ask_depth_1: "0.10623869",
      bid_depth_5: "0.37304475",
      ask_depth_5: "0.17322278",
      bid_depth_15: "0.37304475",
      ask_depth_15: "0.17322278",
      imbalance_5: "0.36579507",
      imbalance_15: "0.36579507",
      websocket_lag_ms: 1000,
      reconnect_count: 0,
    });
  });

  it("creates 5 second orderbook snapshot input with raw payload", async () => {
    const payload = UpbitWebSocketOrderbookSchema.parse(await readJsonFixture("websocket-orderbook.json"));
    const event = toOrderbookEvent(payload, { receivedAt });
    const row = toOrderbookSnapshotRow(event);

    expect(row).toMatchObject({
      exchange: "upbit_krw_spot",
      market: "KRW-BTC",
      captured_at: "2025-05-07T07:06:10.000Z",
      raw_payload_json: {
        type: "orderbook",
        code: "KRW-BTC",
      },
    });
    expect((row.bids_json.levels as unknown[]).slice(0, 1)).toEqual([
      {
        price: "137001000",
        size: "0.03656812",
      },
    ]);
    expect((row.asks_json.levels as unknown[]).slice(0, 1)).toEqual([
      {
        price: "137002000",
        size: "0.10623869",
      },
    ]);
  });

  it("fails fast when orderbook levels are missing", () => {
    expect(() =>
      toOrderbookMetricRow({
        type: "ORDERBOOK",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        asks: [],
        bids: [],
        exchangeTimestamp: "2025-05-07T07:06:13.804Z",
        receivedAt,
      }),
    ).toThrow("orderbook event requires at least one bid and ask level");
  });
});

async function readJsonFixture(filename: string): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "upbit", filename);
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}
