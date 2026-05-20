import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";
import type { MarketDataConnectionStatus, OrderbookLevel } from "./market.js";

export const marketEventKinds = [
  "TRADE",
  "ORDERBOOK_SNAPSHOT",
  "ORDERBOOK_METRIC",
  "TICKER",
  "POLICY_CANDIDATE",
  "STATUS",
] as const;

export type MarketEventKind = (typeof marketEventKinds)[number];
export type MarketEventSourceKind = "RUNTIME" | "FIXTURE" | "DATABASE" | "ADAPTER";
export type MarketEventTradeSide = "BID" | "ASK" | "UNKNOWN";

/**
 * backtest replay와 runtime candidate 비교가 공유하는 이벤트 출처 정보다.
 *
 * sourceId는 fixture 파일, DB cursor, runtime worker처럼 이벤트 묶음을 재현할 수 있는 식별자이며
 * sourceIndex는 같은 source 안에서 원본 순서를 보존해야 할 때 tie-break 보조값으로 사용한다.
 */
export interface MarketEventSourceMetadata {
  sourceKind: MarketEventSourceKind;
  sourceId: string;
  sourceIndex?: number;
  raw?: JsonRecord;
}

/**
 * 이벤트 기반 backtest가 시간순 replay에 사용하는 공통 base contract다.
 *
 * eventTimestamp는 거래소 또는 집계 bucket 기준 시각이고, sequence와 tieBreakKey는 같은 timestamp 안에서도
 * 재생 순서를 결정하기 위한 필수 값이다. 후속 HistoricalEventSource 구현은 이 계약만 보고 deterministic stream을
 * 만들 수 있어야 한다.
 */
export interface BaseMarketEvent<TKind extends MarketEventKind = MarketEventKind> {
  kind: TKind;
  exchangeId: ExchangeId;
  eventTimestamp: TimestampInput;
  receivedAt?: TimestampInput;
  sequence: string;
  tieBreakKey: string;
  source: MarketEventSourceMetadata;
  metadata?: JsonRecord;
}

export interface MarketScopedEvent<TKind extends MarketEventKind = MarketEventKind> extends BaseMarketEvent<TKind> {
  market: MarketCode;
}

export interface MarketTradeEvent extends MarketScopedEvent<"TRADE"> {
  tradeId: string;
  price: NumericString;
  quantity: NumericString;
  side: MarketEventTradeSide;
}

export interface MarketOrderbookSnapshotEvent extends MarketScopedEvent<"ORDERBOOK_SNAPSHOT"> {
  asks: readonly OrderbookLevel[];
  bids: readonly OrderbookLevel[];
}

export interface MarketOrderbookMetricEvent extends MarketScopedEvent<"ORDERBOOK_METRIC"> {
  bestBidPrice?: NumericString;
  bestAskPrice?: NumericString;
  spreadBps?: NumericString;
  bidDepth1?: NumericString;
  askDepth1?: NumericString;
  bidDepth5?: NumericString;
  askDepth5?: NumericString;
  imbalance5?: NumericString;
  metrics?: JsonRecord;
}

export interface MarketTickerEvent extends MarketScopedEvent<"TICKER"> {
  tradePrice: NumericString;
  changeRate?: NumericString;
  accTradePrice24h?: NumericString;
}

export interface MarketPolicyCandidateEvent extends MarketScopedEvent<"POLICY_CANDIDATE"> {
  tradable: boolean;
  warning: boolean;
  caution: boolean;
  reasonCodes: readonly string[];
  minimumOrderNotional?: NumericString;
  bidFeeBps?: NumericString;
  askFeeBps?: NumericString;
  policy?: JsonRecord;
}

export interface MarketStatusReplayEvent extends BaseMarketEvent<"STATUS"> {
  market?: MarketCode;
  status: MarketDataConnectionStatus;
  reasonCode?: string;
  websocketLagMs?: number;
  reconnectCount?: number;
}

export type MarketEvent =
  | MarketTradeEvent
  | MarketOrderbookSnapshotEvent
  | MarketOrderbookMetricEvent
  | MarketTickerEvent
  | MarketPolicyCandidateEvent
  | MarketStatusReplayEvent;

/**
 * MarketEvent replay 순서를 비교한다.
 *
 * 1차 기준은 eventTimestamp, 2차 기준은 sequence, 3차 기준은 tieBreakKey다. sequence가 숫자 문자열이면 safe
 * integer로 변환하지 않고 길이와 문자열 비교로 정렬해 큰 거래소 sequence도 손실 없이 처리한다.
 */
export function compareMarketEvents(left: MarketEvent, right: MarketEvent): number {
  const timestampDiff = readMarketEventTimestampMillis(left) - readMarketEventTimestampMillis(right);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const sequenceDiff = compareSequence(left.sequence, right.sequence);
  if (sequenceDiff !== 0) {
    return sequenceDiff;
  }

  const tieBreakDiff = compareString(left.tieBreakKey, right.tieBreakKey);
  if (tieBreakDiff !== 0) {
    return tieBreakDiff;
  }

  const exchangeDiff = compareString(left.exchangeId, right.exchangeId);
  if (exchangeDiff !== 0) {
    return exchangeDiff;
  }

  return compareString(left.market ?? "*", right.market ?? "*");
}

/**
 * 입력 배열을 바꾸지 않고 deterministic replay 순서로 정렬한 MarketEvent 목록을 반환한다.
 */
export function sortMarketEvents(events: readonly MarketEvent[]): MarketEvent[] {
  return [...events].sort(compareMarketEvents);
}

/**
 * timestamp, sequence, tieBreakKey 조합이 중복되지 않는지 확인한다.
 *
 * 중복 key가 있으면 replay source가 실행마다 다른 순서를 만들 수 있으므로 fixture 또는 DB source 경계에서
 * fail-fast한다.
 */
export function assertUniqueMarketEventOrderKeys(events: readonly MarketEvent[]): void {
  const seen = new Set<string>();

  for (const event of events) {
    const orderKey = createMarketEventOrderKey(event);
    if (seen.has(orderKey)) {
      throw new Error(`Duplicate MarketEvent order key: ${orderKey}`);
    }
    seen.add(orderKey);
  }
}

/**
 * 사람이 읽을 수 있고 테스트 snapshot에 쓰기 쉬운 replay order key를 만든다.
 */
export function createMarketEventOrderKey(event: MarketEvent): string {
  return [
    new Date(readMarketEventTimestampMillis(event)).toISOString(),
    event.exchangeId,
    event.market ?? "*",
    event.sequence,
    event.tieBreakKey,
  ].join("#");
}

function readMarketEventTimestampMillis(event: Pick<BaseMarketEvent, "eventTimestamp">): number {
  const milliseconds =
    event.eventTimestamp instanceof Date
      ? event.eventTimestamp.getTime()
      : parseTimezoneExplicitTimestamp(event.eventTimestamp);

  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid MarketEvent eventTimestamp: ${String(event.eventTimestamp)}`);
  }

  return milliseconds;
}

function compareSequence(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  if (isUnsignedIntegerText(left) && isUnsignedIntegerText(right)) {
    const normalizedLeft = trimLeadingZeroes(left);
    const normalizedRight = trimLeadingZeroes(right);

    if (normalizedLeft.length !== normalizedRight.length) {
      return normalizedLeft.length - normalizedRight.length;
    }

    const normalizedDiff = compareString(normalizedLeft, normalizedRight);
    if (normalizedDiff !== 0) {
      return normalizedDiff;
    }

    // "1"과 "01"처럼 숫자 값은 같아도 raw sequence가 다르면 입력 순서에 기대지 않도록 마지막으로 원문을 비교한다.
    return compareString(left, right);
  }

  return compareString(left, right);
}

function compareString(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function isUnsignedIntegerText(value: string): boolean {
  return /^\d+$/u.test(value);
}

function trimLeadingZeroes(value: string): string {
  const trimmed = value.replace(/^0+/u, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

function parseTimezoneExplicitTimestamp(value: string): number {
  if (!isTimezoneExplicitIsoTimestamp(value)) {
    throw new Error(`MarketEvent timestamp must include an explicit timezone: ${value}`);
  }

  return Date.parse(value);
}

function isTimezoneExplicitIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
}
