import type { HistoricalEventReplayRequest, HistoricalEventSource } from "../ports/index.js";
import type { MarketEvent } from "../../domain/index.js";
import { parseMarketEventTimestampNanos } from "../../domain/index.js";
import type { MarketEventFixture } from "./market-event-fixture.js";
import { parseMarketEventFixture, sortMarketEventFixtureEvents } from "./market-event-fixture.js";

interface NormalizedHistoricalEventReplayRequest {
  exchangeId: HistoricalEventReplayRequest["exchangeId"] | undefined;
  markets: ReadonlySet<string> | undefined;
  fromNanos: bigint | undefined;
  toNanos: bigint | undefined;
  sourceId: string | undefined;
  limit: number | undefined;
}

/**
 * fixture JSON을 deterministic HistoricalEventSource로 감싼다.
 *
 * constructor 시점에 fixture schema와 replay order key를 검증하고, replay 요청마다 정렬된 동일 event stream에
 * 필터만 적용한다. 이 source는 runtime worker lifecycle이나 file system에 의존하지 않아 backtest orchestrator가
 * 같은 입력을 반복 실행할 수 있는 기반으로 사용한다.
 */
export class FixtureHistoricalEventSource implements HistoricalEventSource {
  private readonly orderedEvents: readonly MarketEvent[];

  constructor(fixture: MarketEventFixture) {
    this.orderedEvents = sortMarketEventFixtureEvents(fixture);
  }

  async *replay(request: HistoricalEventReplayRequest = {}): AsyncIterable<MarketEvent> {
    const normalizedRequest = normalizeHistoricalEventReplayRequest(request);
    let yieldedCount = 0;

    if (normalizedRequest.limit === 0) {
      return;
    }

    for (const event of this.orderedEvents) {
      if (!matchesHistoricalEventReplayRequest(event, normalizedRequest)) {
        continue;
      }

      yield cloneMarketEvent(event);
      yieldedCount += 1;

      // limit은 deterministic 정렬과 필터를 모두 통과한 event 수 기준으로 적용한다.
      if (normalizedRequest.limit !== undefined && yieldedCount >= normalizedRequest.limit) {
        return;
      }
    }
  }
}

function cloneMarketEvent(event: MarketEvent): MarketEvent {
  return structuredClone(event) as MarketEvent;
}

/**
 * unknown fixture input을 검증한 뒤 fixture 기반 HistoricalEventSource를 만든다.
 */
export function createFixtureHistoricalEventSource(input: unknown): FixtureHistoricalEventSource {
  return new FixtureHistoricalEventSource(parseMarketEventFixture(input));
}

function normalizeHistoricalEventReplayRequest(
  request: HistoricalEventReplayRequest,
): NormalizedHistoricalEventReplayRequest {
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 0)) {
    throw new Error("HistoricalEventReplayRequest.limit must be a non-negative integer");
  }

  return {
    exchangeId: request.exchangeId,
    markets: request.markets === undefined ? undefined : new Set(request.markets),
    fromNanos: request.from === undefined ? undefined : parseMarketEventTimestampNanos(request.from),
    toNanos: request.to === undefined ? undefined : parseMarketEventTimestampNanos(request.to),
    sourceId: request.sourceId,
    limit: request.limit,
  };
}

function matchesHistoricalEventReplayRequest(
  event: MarketEvent,
  request: NormalizedHistoricalEventReplayRequest,
): boolean {
  if (request.exchangeId !== undefined && event.exchangeId !== request.exchangeId) {
    return false;
  }

  if (request.sourceId !== undefined && event.source.sourceId !== request.sourceId) {
    return false;
  }

  if (request.markets !== undefined && event.market !== undefined && !request.markets.has(event.market)) {
    return false;
  }

  const eventTimestampNanos = parseMarketEventTimestampNanos(event.eventTimestamp);

  if (request.fromNanos !== undefined && eventTimestampNanos < request.fromNanos) {
    return false;
  }

  return request.toNanos === undefined || eventTimestampNanos <= request.toNanos;
}
