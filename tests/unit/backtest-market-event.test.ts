import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarketEventFixture, sortMarketEventFixtureEvents } from "../../src/application/index.js";
import type { HistoricalEventSource } from "../../src/application/index.js";
import { createMarketEventOrderKey, sortMarketEvents } from "../../src/domain/index.js";
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
    expect(sorted.map(createMarketEventOrderKey)).toEqual([
      "2026-05-19T23:59:59.900Z#1#policy:public",
      "2026-05-20T00:00:00.000Z#1#status:connected",
      "2026-05-20T00:00:00.020Z#1#orderbook_metric:1s",
      "2026-05-20T00:00:00.050Z#1#ticker:snapshot",
      "2026-05-20T00:00:00.100Z#2#orderbook:depth",
      "2026-05-20T00:00:00.100Z#10#trade:17303368620470000",
    ]);
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

  it("keeps HistoricalEventSource independent from runtime worker lifecycle", async () => {
    const fixture = parseMarketEventFixture(await readFixture());
    const source: HistoricalEventSource = {
      async *replay(request) {
        for (const event of sortMarketEventFixtureEvents(fixture)) {
          if (request?.markets !== undefined && !request.markets.includes(event.market)) {
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
