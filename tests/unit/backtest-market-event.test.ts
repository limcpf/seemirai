import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarketEventFixture, sortMarketEventFixtureEvents } from "../../src/application/index.js";
import type { HistoricalEventSource } from "../../src/application/index.js";
import { createMarketEventOrderKey, parseMarketEventTimestampNanos, sortMarketEvents } from "../../src/domain/index.js";
import type { MarketEvent } from "../../src/domain/index.js";

describe("backtest MarketEvent foundation", () => {
  it("parses the shared fixture schema for all M7 event kinds", async () => {
    const fixture = parseMarketEventFixture(await readFixture());

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.events.map((event) => event.kind).sort()).toEqual([
      "ORDERBOOK_METRIC",
      "ORDERBOOK_SNAPSHOT",
      "POLICY_CANDIDATE",
      "STATUS",
      "TICKER",
      "TRADE",
    ]);
  });

  it("sorts by event timestamp, numeric sequence, and tie-break key without mutating input", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const sorted = sortMarketEventFixtureEvents(fixture);

    expect(fixture.events[0]?.kind).toBe("TRADE");
    expect(sorted.map((event) => event.kind)).toEqual([
      "POLICY_CANDIDATE",
      "STATUS",
      "ORDERBOOK_METRIC",
      "TICKER",
      "ORDERBOOK_SNAPSHOT",
      "TRADE",
    ]);
    expect(sorted.map((event) => parseOrderKey(createMarketEventOrderKey(event)))).toEqual([
      expectedOrderKeyParts("2026-05-19T23:59:59.900Z", "KRW-BTC", "1", "policy:public"),
      expectedOrderKeyParts("2026-05-20T00:00:00.000Z", "*", "1", "status:connected"),
      expectedOrderKeyParts("2026-05-20T00:00:00.020Z", "KRW-BTC", "1", "orderbook_metric:1s"),
      expectedOrderKeyParts("2026-05-20T00:00:00.050Z", "KRW-BTC", "1", "ticker:snapshot"),
      expectedOrderKeyParts("2026-05-20T00:00:00.100Z", "KRW-BTC", "2", "orderbook:depth"),
      expectedOrderKeyParts("2026-05-20T00:00:00.100Z", "KRW-BTC", "10", "trade:17303368620470000"),
    ]);
  });

  it("preserves sub-millisecond timestamp precision in sorting and order keys", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const trade = fixture.events.find((event): event is Extract<MarketEvent, { kind: "TRADE" }> => event.kind === "TRADE");

    expect(trade).toBeDefined();

    const earlier = {
      ...trade!,
      eventTimestamp: "2026-05-20T00:00:00.123456Z",
      sequence: "1",
      tieBreakKey: "same",
      tradeId: "sub-ms-earlier",
    };
    const later = {
      ...trade!,
      eventTimestamp: "2026-05-20T00:00:00.123999Z",
      sequence: "1",
      tieBreakKey: "same",
      tradeId: "sub-ms-later",
    };

    expect(sortMarketEvents([later, earlier]).map((event) => event.eventTimestamp)).toEqual([
      "2026-05-20T00:00:00.123456Z",
      "2026-05-20T00:00:00.123999Z",
    ]);
    expect(createMarketEventOrderKey(earlier)).not.toBe(createMarketEventOrderKey(later));
    expect(parseMarketEventTimestampNanos(earlier.eventTimestamp)).toBeLessThan(
      parseMarketEventTimestampNanos(later.eventTimestamp),
    );
  });

  it("uses tie-break key when timestamp and sequence are identical", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const [left, right] = fixture.events.slice(0, 2) as [MarketEvent, MarketEvent];
    const sorted = sortMarketEvents([
      {
        ...left,
        sequence: "1",
        tieBreakKey: "b",
      },
      {
        ...right,
        sequence: "1",
        tieBreakKey: "a",
      },
    ]);

    expect(sorted.map((event) => event.tieBreakKey)).toEqual(["a", "b"]);
  });

  it("keeps sequence ordering deterministic when numeric strings normalize to the same value", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const [left, right] = fixture.events.slice(0, 2) as [MarketEvent, MarketEvent];
    const sorted = sortMarketEvents([
      {
        ...left,
        sequence: "1",
        tieBreakKey: "same",
      },
      {
        ...right,
        sequence: "01",
        tieBreakKey: "same",
      },
    ]);

    expect(sorted.map((event) => event.sequence)).toEqual(["01", "1"]);
  });

  it("allows identical local order triples across different markets", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const first = fixture.events[0]!;
    const otherMarket = {
      ...first,
      market: "KRW-ETH",
    };

    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [first, otherMarket],
      }),
    ).not.toThrow();
    expect(sortMarketEvents([otherMarket, first]).map((event) => event.market)).toEqual(["KRW-BTC", "KRW-ETH"]);
  });

  it("rejects duplicate replay order keys before a source can stream nondeterministically", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const duplicate = {
      schemaVersion: 1,
      events: [
        fixture.events[0],
        {
          ...fixture.events[0]!,
          kind: "TRADE",
          tradeId: "duplicate-trade",
        },
      ],
    };

    expect(() => parseMarketEventFixture(duplicate)).toThrow("Duplicate MarketEvent order key");
  });

  it("serializes replay order keys without delimiter collisions", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const trade = fixture.events.find((event): event is Extract<MarketEvent, { kind: "TRADE" }> => event.kind === "TRADE");

    expect(trade).toBeDefined();

    const left = {
      ...trade!,
      sequence: "1#2",
      tieBreakKey: "3",
      tradeId: "delimiter-left",
    };
    const right = {
      ...trade!,
      sequence: "1",
      tieBreakKey: "2#3",
      tradeId: "delimiter-right",
    };

    expect(createMarketEventOrderKey(left)).not.toBe(createMarketEventOrderKey(right));
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [left, right],
      }),
    ).not.toThrow();
  });

  it("rejects invalid timestamps, negative amount fields, and non-decimal numeric strings at the fixture boundary", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const trade = fixture.events.find((event): event is Extract<MarketEvent, { kind: "TRADE" }> => event.kind === "TRADE");
    const orderbook = fixture.events.find(
      (event): event is Extract<MarketEvent, { kind: "ORDERBOOK_SNAPSHOT" }> => event.kind === "ORDERBOOK_SNAPSHOT",
    );

    expect(trade).toBeDefined();
    expect(orderbook).toBeDefined();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...trade!,
            eventTimestamp: "2026-05-20 00:00:00",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...trade!,
            eventTimestamp: "2026-02-30T00:00:00Z",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...trade!,
            price: "-1",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...orderbook!,
            asks: [
              {
                ...orderbook!.asks[0]!,
                size: "-0.1",
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...trade!,
            price: "not-a-number",
          },
        ],
      }),
    ).toThrow();
  });

  it("allows signed rate fields while amount fields stay non-negative", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const metric = fixture.events.find(
      (event): event is Extract<MarketEvent, { kind: "ORDERBOOK_METRIC" }> => event.kind === "ORDERBOOK_METRIC",
    );
    const ticker = fixture.events.find((event): event is Extract<MarketEvent, { kind: "TICKER" }> => event.kind === "TICKER");

    expect(metric).toBeDefined();
    expect(ticker).toBeDefined();
    expect(() =>
      parseMarketEventFixture({
        schemaVersion: 1,
        events: [
          {
            ...metric!,
            imbalance5: "-0.5",
          },
          {
            ...ticker!,
            changeRate: "-0.01",
          },
        ],
      }),
    ).not.toThrow();
  });

  it("keeps HistoricalEventSource independent from runtime worker lifecycle", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const source: HistoricalEventSource = {
      async *replay(request) {
        for (const event of sortMarketEventFixtureEvents(fixture)) {
          if (request?.markets !== undefined && event.market !== undefined && !request.markets.includes(event.market)) {
            continue;
          }

          yield event;
        }
      },
    };
    const replayed: MarketEvent[] = [];

    for await (const event of source.replay({ markets: ["KRW-BTC"] })) {
      replayed.push(event);
    }

    expect(replayed).toHaveLength(6);
    expect(replayed[0]).toMatchObject({
      kind: "POLICY_CANDIDATE",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
    });
  });
});

async function readFixture(): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "backtest", "market-events.json");
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}

function expectedOrderKeyParts(timestamp: string, market: string, sequence: string, tieBreakKey: string): string[] {
  return [parseMarketEventTimestampNanos(timestamp).toString(), "upbit_krw_spot", market, sequence, tieBreakKey];
}

function parseOrderKey(orderKey: string): string[] {
  const value = JSON.parse(orderKey) as unknown;

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Invalid order key shape: ${orderKey}`);
  }

  return value;
}
