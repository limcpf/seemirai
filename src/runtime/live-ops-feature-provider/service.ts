import {
  calculateM11FeatureSnapshot,
  M11_FEATURE_KEYS,
  type FeatureCalculationFailureReasonCode,
  type FeatureCalculationOptions,
  type FeatureCalculationResult,
  type FeatureCostInput,
  type FeatureFailureResult,
} from "../../application/index.js";
import {
  parseMarketEventTimestampNanos,
  type ExchangeId,
  type JsonRecord,
  type MarketCode,
  type MarketDataEvent,
  type TimestampInput,
} from "../../domain/index.js";

/** DB window에서 복원한 live ops feature snapshot source 식별자다. */
export const LIVE_OPS_DB_BACKED_FEATURE_SOURCE = "live_ops_db_window";

/** live ops DB-backed feature provider의 기본 조회 window다. */
export const DEFAULT_LIVE_OPS_FEATURE_WINDOW_MS = 21 * 60_000;

/** live ops DB-backed feature provider가 주문 후보 전 요구하는 기본 체결 sample 수다. */
export const DEFAULT_LIVE_OPS_FEATURE_MIN_TRADE_COUNT = 20;

/** live ops DB-backed feature provider가 주문 후보 전 요구하는 기본 호가 sample 수다. */
export const DEFAULT_LIVE_OPS_FEATURE_MIN_ORDERBOOK_COUNT = 2;

/** live ops DB-backed feature provider가 허용하는 최신 DB event의 기본 최대 지연이다. */
export const DEFAULT_LIVE_OPS_FEATURE_MAX_LATEST_EVENT_LAG_MS = 30_000;

/**
 * live ops feature provider가 DB reader에 요청하는 window 경계다.
 *
 * caller는 decision tick 기준 시각을 먼저 확정하고 provider가 계산한 UTC ISO window를 reader에 넘긴다.
 * reader는 이 경계를 확장하거나 fallback source를 섞지 않아야 하며, 외부 side effect는 DB read에 한정된다.
 */
export interface LiveOpsDbBackedFeatureWindowQuery {
  readonly exchangeId: ExchangeId;
  readonly market: MarketCode;
  readonly windowStartAt: string;
  readonly windowEndAt: string;
}

/**
 * DB reader가 반환하는 feature window다.
 *
 * `events`는 trades/orderbook snapshot 등 DB row를 domain `MarketDataEvent`로 복원한 값이며, provider는 이 값을
 * 0-fill 없이 그대로 feature calculator에 전달한다. `metadata`는 audit/debug용 보조 정보로만 사용된다.
 */
export interface LiveOpsDbBackedFeatureWindow {
  readonly events: readonly MarketDataEvent[];
  readonly metadata?: JsonRecord;
}

/**
 * live ops DB-backed feature provider가 의존하는 read port다.
 *
 * 구현체는 PostgreSQL, fixture DB, test fake 중 하나일 수 있지만, public tick이나 메모리 fallback을 여기서
 * 암묵적으로 섞으면 안 된다. fallback 판단은 provider 결과를 받은 상위 live ops runtime에서 명시적으로 기록해야 한다.
 */
export interface LiveOpsDbBackedFeatureWindowReader {
  loadLiveOpsFeatureWindow(query: LiveOpsDbBackedFeatureWindowQuery): Promise<LiveOpsDbBackedFeatureWindow>;
}

/**
 * DB-backed feature window의 sample 분포다.
 *
 * guard는 target exchange/market에 맞는 sample만 체결·호가 수로 인정하고, 다른 market row는 calculator의
 * contamination 검증에 남겨 전체 snapshot을 실패시키는 invariant를 유지한다.
 */
export interface LiveOpsDbBackedFeatureSampleCounts {
  readonly orderbooks: number;
  readonly status: number;
  readonly tickers: number;
  readonly total: number;
  readonly trades: number;
}

/**
 * live ops autonomous strategy에 전달할 DB-backed feature snapshot 입력이다.
 *
 * provider는 DB reader 호출, sample/freshness guard, 순수 feature calculator 호출까지만 책임진다. broker, 주문,
 * clock read, DB write side effect는 만들지 않으며, 실패 시 모든 feature를 실패 결과로 반환해 후보 생성을 막는다.
 */
export interface LiveOpsDbBackedFeatureSnapshotInput {
  readonly reader: LiveOpsDbBackedFeatureWindowReader;
  readonly exchangeId: ExchangeId;
  readonly market: MarketCode;
  readonly observedAt: TimestampInput;
  readonly windowMs?: number;
  readonly minTradeCount?: number;
  readonly minOrderbookCount?: number;
  readonly maxLatestEventLagMs?: number;
  readonly cost?: FeatureCostInput;
  readonly featureOptions?: FeatureCalculationOptions;
  readonly metadata?: JsonRecord;
}

interface ProviderFailureInput {
  readonly observedAt: string;
  readonly windowStartAt?: string;
  readonly windowEndAt: string;
  readonly reasonCode: FeatureCalculationFailureReasonCode;
  readonly message: string;
  readonly metadata: JsonRecord;
}

/**
 * live ops autonomous strategy용 DB-backed feature snapshot을 읽고 계산한다.
 *
 * 호출자는 decision tick 기준의 exchange/market/observedAt과 DB reader를 넘긴다. 이 함수는 DB window를 먼저
 * 조회한 뒤 sample 부족과 최신 event stale을 주문 후보 생성 전에 차단하고, 성공한 경우에만 M11 calculator에
 * 위임한다. public tick fallback이나 zero-fill은 수행하지 않는다.
 */
export async function loadLiveOpsDbBackedFeatureSnapshot(
  input: LiveOpsDbBackedFeatureSnapshotInput,
): Promise<FeatureCalculationResult> {
  const observedAt = parseProviderTimestamp(input.observedAt);
  const windowMs = resolvePositiveInteger(input.windowMs, DEFAULT_LIVE_OPS_FEATURE_WINDOW_MS, "windowMs");
  const minTradeCount = resolveNonNegativeInteger(
    input.minTradeCount,
    DEFAULT_LIVE_OPS_FEATURE_MIN_TRADE_COUNT,
    "minTradeCount",
  );
  const minOrderbookCount = resolveNonNegativeInteger(
    input.minOrderbookCount,
    DEFAULT_LIVE_OPS_FEATURE_MIN_ORDERBOOK_COUNT,
    "minOrderbookCount",
  );
  const maxLatestEventLagMs = resolveNonNegativeInteger(
    input.maxLatestEventLagMs,
    DEFAULT_LIVE_OPS_FEATURE_MAX_LATEST_EVENT_LAG_MS,
    "maxLatestEventLagMs",
  );
  const windowEndAt = observedAt.toISOString();
  const windowStartAt = new Date(observedAt.getTime() - windowMs).toISOString();

  const baseMetadata: JsonRecord = {
    ...input.metadata,
    exchangeId: input.exchangeId,
    market: input.market,
    source: LIVE_OPS_DB_BACKED_FEATURE_SOURCE,
    windowEndAt,
    windowStartAt,
  };

  let window: LiveOpsDbBackedFeatureWindow;
  try {
    window = await input.reader.loadLiveOpsFeatureWindow({
      exchangeId: input.exchangeId,
      market: input.market,
      windowStartAt,
      windowEndAt,
    });
  } catch (error) {
    // DB window를 읽지 못하면 이전 tick이나 public fallback으로 조용히 대체하지 않고 후보 생성을 닫는다.
    return createProviderFailureSnapshot({
      observedAt: windowEndAt,
      windowEndAt,
      windowStartAt,
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
      message: error instanceof Error ? error.message : "DB feature window could not be loaded",
      metadata: {
        ...baseMetadata,
        sampleCounts: createEmptySampleCounts(),
      },
    });
  }

  const sampleCounts = countSamples(window.events, input.exchangeId, input.market);
  const metadata = createSnapshotMetadata(baseMetadata, window.metadata, sampleCounts);

  if (sampleCounts.trades < minTradeCount || sampleCounts.orderbooks < minOrderbookCount) {
    // 계산식이 일부 feature를 만들 수 있어도 DB sample 부족 상태는 주문 후보 전 전부 fail-closed로 닫는다.
    return createProviderFailureSnapshot({
      observedAt: windowEndAt,
      windowEndAt,
      windowStartAt,
      reasonCode: "FEATURE_INSUFFICIENT_INPUT",
      message: `DB feature window samples are insufficient: trades=${sampleCounts.trades}/${minTradeCount}, orderbooks=${sampleCounts.orderbooks}/${minOrderbookCount}`,
      metadata,
    });
  }

  const latestEventAt = findLatestEventTimestamp(window.events);
  const latestTradeEventAt = findLatestTradeEventTimestamp(window.events, input.exchangeId, input.market);
  const latestEventLagMs = observedAt.getTime() - latestEventAt.getTime();
  const latestTradeEventLagMs = observedAt.getTime() - latestTradeEventAt.getTime();
  const freshnessMetadata = {
    ...metadata,
    latestEventAt: latestEventAt.toISOString(),
    latestEventLagMs,
    latestTradeEventAt: latestTradeEventAt.toISOString(),
    latestTradeEventLagMs,
  };

  if (latestEventLagMs < 0 || latestEventLagMs > maxLatestEventLagMs) {
    // stale 또는 미래 timestamp가 들어오면 오래된 feature가 신규 주문을 열 수 있어 전체 snapshot을 실패시킨다.
    return createProviderFailureSnapshot({
      observedAt: windowEndAt,
      windowEndAt,
      windowStartAt,
      reasonCode: "FEATURE_MARKET_DATA_STALE",
      message: `DB feature window latest event is stale: latestEventLagMs=${latestEventLagMs}, maxLatestEventLagMs=${maxLatestEventLagMs}`,
      metadata: freshnessMetadata,
    });
  }
  if (latestTradeEventLagMs < 0 || latestTradeEventLagMs > maxLatestEventLagMs) {
    // 체결 기반 feature는 최신 호가로 보정할 수 없으므로 trade stream stale도 독립적으로 fail-closed 한다.
    return createProviderFailureSnapshot({
      observedAt: windowEndAt,
      windowEndAt,
      windowStartAt,
      reasonCode: "FEATURE_MARKET_DATA_STALE",
      message: `DB feature window latest trade is stale: latestTradeEventLagMs=${latestTradeEventLagMs}, maxLatestEventLagMs=${maxLatestEventLagMs}`,
      metadata: freshnessMetadata,
    });
  }

  return calculateM11FeatureSnapshot(
    {
      observedAt: windowEndAt,
      events: window.events,
      ...(input.cost === undefined ? {} : { cost: input.cost }),
      metadata: freshnessMetadata,
    },
    input.featureOptions,
  );
}

function parseProviderTimestamp(value: TimestampInput): Date {
  if (typeof value === "string") {
    parseMarketEventTimestampNanos(value);
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid feature provider timestamp: ${String(value)}`);
  }

  return parsed;
}

function resolvePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return resolved;
}

function resolveNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;

  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return resolved;
}

function createSnapshotMetadata(
  baseMetadata: JsonRecord,
  windowMetadata: JsonRecord | undefined,
  sampleCounts: LiveOpsDbBackedFeatureSampleCounts,
): JsonRecord {
  return {
    ...baseMetadata,
    ...(windowMetadata === undefined ? {} : { windowMetadata }),
    sampleCounts,
  };
}

function countSamples(
  events: readonly MarketDataEvent[],
  exchangeId: ExchangeId,
  market: MarketCode,
): LiveOpsDbBackedFeatureSampleCounts {
  const counts = {
    orderbooks: 0,
    status: 0,
    tickers: 0,
    total: events.length,
    trades: 0,
  };

  for (const event of events) {
    if (event.type === "STATUS") {
      counts.status += 1;
      continue;
    }

    if (event.exchangeId !== exchangeId || event.market !== market) {
      continue;
    }

    switch (event.type) {
      case "ORDERBOOK":
        counts.orderbooks += 1;
        break;
      case "TICKER":
        counts.tickers += 1;
        break;
      case "TRADE":
        counts.trades += 1;
        break;
    }
  }

  return counts;
}

function createEmptySampleCounts(): LiveOpsDbBackedFeatureSampleCounts {
  return {
    orderbooks: 0,
    status: 0,
    tickers: 0,
    total: 0,
    trades: 0,
  };
}

function findLatestEventTimestamp(events: readonly MarketDataEvent[]): Date {
  let latestEventAt: Date | undefined;

  for (const event of events) {
    const eventAt = parseProviderTimestamp(readEventTimestamp(event));
    if (latestEventAt === undefined || eventAt.getTime() > latestEventAt.getTime()) {
      latestEventAt = eventAt;
    }
  }

  if (latestEventAt === undefined) {
    throw new Error("DB feature window has no latest event");
  }

  return latestEventAt;
}

/**
 * target market의 최신 trade event 시각을 찾는다.
 *
 * provider 내부의 순수 검증 경계에서만 호출되며, 입력 window의 event 배열을 변경하지 않는다. 반환값은
 * trade-derived feature가 주문 후보를 열어도 되는 freshness invariant를 별도로 검사하는 데 사용된다.
 */
function findLatestTradeEventTimestamp(
  events: readonly MarketDataEvent[],
  exchangeId: ExchangeId,
  market: MarketCode,
): Date {
  let latestTradeEventAt: Date | undefined;

  for (const event of events) {
    if (event.type !== "TRADE" || event.exchangeId !== exchangeId || event.market !== market) {
      continue;
    }
    const eventAt = parseProviderTimestamp(event.exchangeTimestamp);
    if (latestTradeEventAt === undefined || eventAt.getTime() > latestTradeEventAt.getTime()) {
      latestTradeEventAt = eventAt;
    }
  }

  if (latestTradeEventAt === undefined) {
    throw new Error("DB feature window has no latest trade event");
  }

  return latestTradeEventAt;
}

function readEventTimestamp(event: MarketDataEvent): TimestampInput {
  return event.type === "STATUS" ? event.observedAt : event.exchangeTimestamp;
}

function createProviderFailureSnapshot(input: ProviderFailureInput): FeatureCalculationResult {
  const results: FeatureFailureResult[] = M11_FEATURE_KEYS.map((key) => ({
    status: "failed",
    key,
    reasonCode: input.reasonCode,
    message: input.message,
    observedAt: input.observedAt,
    windowEndAt: input.windowEndAt,
    ...(input.windowStartAt === undefined ? {} : { windowStartAt: input.windowStartAt }),
  }));

  return {
    status: "failed",
    observedAt: input.observedAt,
    features: {},
    results,
    failureReasons: results,
    metadata: input.metadata,
  };
}
