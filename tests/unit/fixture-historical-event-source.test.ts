import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFixtureHistoricalEventSource } from "../../src/application/index.js";
import type { HistoricalEventSource } from "../../src/application/index.js";
import { createMarketEventOrderKey } from "../../src/domain/index.js";
import type { MarketEvent } from "../../src/domain/index.js";

describe("FixtureHistoricalEventSource", () => {
  it("replays fixture events in the same deterministic order across iterations", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());
    const firstReplay = await collectEvents(source);
    const secondReplay = await collectEvents(source);

    expect(firstReplay.map(createMarketEventOrderKey)).toEqual(secondReplay.map(createMarketEventOrderKey));
    expect(firstReplay.map((event) => event.kind)).toEqual([
      "POLICY_CANDIDATE",
      "STATUS",
      "ORDERBOOK_METRIC",
      "TICKER",
      "ORDERBOOK_SNAPSHOT",
      "TRADE",
    ]);
  });

  it("filters by source, exchange, market, and inclusive event timestamp window", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());
    const replayed = await collectEvents(
      source,
      source.replay({
        exchangeId: "upbit_krw_spot",
        sourceId: "market-events.json",
        markets: ["KRW-BTC"],
        from: "2026-05-20T00:00:00.000Z",
        to: "2026-05-20T00:00:00.050Z",
      }),
    );

    expect(replayed.map((event) => event.kind)).toEqual(["STATUS", "ORDERBOOK_METRIC", "TICKER"]);
    expect(replayed.map((event) => event.source.sourceId)).toEqual([
      "market-events.json",
      "market-events.json",
      "market-events.json",
    ]);
  });

  it("keeps marketless shared status events when replay is scoped to a market", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());
    const replayed = await collectEvents(source, source.replay({ markets: ["KRW-ETH"] }));

    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      kind: "STATUS",
      status: "CONNECTED",
    });
    expect(replayed[0]?.market).toBeUndefined();
  });

  it("applies limit after deterministic sorting and filtering", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());
    const limited = await collectEvents(source, source.replay({ limit: 3 }));
    const empty = await collectEvents(source, source.replay({ limit: 0 }));

    expect(limited.map((event) => event.kind)).toEqual(["POLICY_CANDIDATE", "STATUS", "ORDERBOOK_METRIC"]);
    expect(empty).toEqual([]);
  });

  it("does not let consumer-side event mutation leak into later replays", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());
    const firstReplay = await collectEvents(source);
    const firstEvent = firstReplay[0];
    expect(firstEvent).toBeDefined();

    firstEvent!.source.sourceId = "mutated-by-consumer";

    const secondReplay = await collectEvents(source);

    expect(secondReplay[0]).not.toBe(firstEvent);
    expect(secondReplay[0]?.source.sourceId).toBe("market-events.json");
  });

  it("returns an empty stream when source or exchange filters do not match", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());

    await expect(collectEvents(source, source.replay({ sourceId: "missing-fixture.json" }))).resolves.toEqual([]);
    await expect(collectEvents(source, source.replay({ exchangeId: "missing_exchange" }))).resolves.toEqual([]);
  });

  it("rejects invalid replay limits before streaming events", async () => {
    const source = createFixtureHistoricalEventSource(await readFixture());

    await expect(collectEvents(source, source.replay({ limit: -1 }))).rejects.toThrow(
      "HistoricalEventReplayRequest.limit must be a non-negative integer",
    );
    await expect(collectEvents(source, source.replay({ limit: 1.5 }))).rejects.toThrow(
      "HistoricalEventReplayRequest.limit must be a non-negative integer",
    );
  });
});

async function readFixture(): Promise<unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "backtest", "market-events.json");
  const json = await readFile(fixturePath, "utf8");

  return JSON.parse(json) as unknown;
}

async function collectEvents(
  source: HistoricalEventSource,
  stream?: AsyncIterable<MarketEvent>,
): Promise<MarketEvent[]> {
  const events: MarketEvent[] = [];

  for await (const event of stream ?? source.replay()) {
    events.push(event);
  }

  return events;
}
