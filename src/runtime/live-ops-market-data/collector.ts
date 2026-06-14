import type {
  MarketCode,
  MarketDataStatusEvent,
} from "../../domain/index.js";
import {
  loadLiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsConfig,
} from "../live-ops-config.js";
import {
  persistMarketDataRuntimeEvents,
} from "../market-data-runtime.js";
import type {
  MarketDataRuntimeEvent,
  MarketDataRuntimeEventStore,
  MarketDataRuntimeOrderbookPersistenceOptions,
  MarketDataRuntimePersistenceSummary,
} from "../market-data-runtime.js";

/**
 * live ops market data collector의 최종 상태 코드다.
 *
 * 책임:
 * - TUI/CLI 자동화가 collector 결과를 안정적으로 분기하게 한다.
 * - `ready`가 아니면 analysis/decision lifecycle로 전진하지 않는 invariant를 유지한다.
 */
export type LiveOpsMarketDataCollectorStatus = "ready" | "blocked";

/**
 * market data collector가 읽은 source profile이다.
 *
 * 책임:
 * - 실제 Upbit public stream과 fixture smoke를 같은 summary contract로 구분한다.
 * - source profile은 credential이나 provider raw payload를 포함하지 않는 표시용 식별자다.
 */
export type LiveOpsMarketDataSourceProfile = "upbit_public" | "fixture";

/**
 * live ops market data collector 입력 계약이다.
 *
 * 책임:
 * - production live ops config와 이미 조립된 event source/store를 collector 경계로 전달한다.
 * - 실제 DB 연결과 WebSocket 연결 생성은 caller가 담당하고, collector는 입력 event를 검증한 뒤 DB-backed store에 저장한다.
 *
 * invariant:
 * - config는 `LiveOpsConfig` schema로 다시 해석되어 KRW-BTC 단일, UPBIT_PUBLIC, websocket enabled 조건을 유지해야 한다.
 * - 이 타입은 credential, DB URL, raw provider payload 원문을 summary로 올리지 않는다.
 */
export interface CollectLiveOpsMarketDataInput {
  readonly config: LiveOpsConfig | unknown;
  readonly events: AsyncIterable<MarketDataRuntimeEvent>;
  readonly store: MarketDataRuntimeEventStore;
  readonly sourceProfile?: LiveOpsMarketDataSourceProfile;
  readonly workerId?: string;
  readonly orderbook?: MarketDataRuntimeOrderbookPersistenceOptions;
}

/**
 * live ops market data collector의 개별 검증 결과다.
 *
 * 책임:
 * - TUI/Telegram/CLI가 같은 사용자-facing 상태를 보여줄 수 있도록 code와 한국어 message를 분리한다.
 * - `details`에는 count, market, timestamp처럼 secret-free evidence만 들어간다.
 */
export interface LiveOpsMarketDataCollectorCheck {
  readonly name: "config" | "event_source" | "persistence" | "freshness";
  readonly status: "ok" | "blocked";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * live ops market data collector의 secret-safe 최종 요약이다.
 *
 * 책임:
 * - DB-backed collector가 live ops lifecycle에서 다음 단계로 넘어가도 되는지 `ready`로 표현한다.
 * - 저장 count와 최신 heartbeat만 노출하며 raw Upbit payload, credential, DB 연결 문자열은 포함하지 않는다.
 */
export interface LiveOpsMarketDataCollectorSummary {
  readonly status: LiveOpsMarketDataCollectorStatus;
  readonly ready: boolean;
  readonly provider: "UPBIT_PUBLIC";
  readonly market: MarketCode;
  readonly sourceProfile: LiveOpsMarketDataSourceProfile;
  readonly message: string;
  readonly latestHeartbeatAt: string | null;
  readonly persisted: MarketDataRuntimePersistenceSummary;
  readonly checks: readonly LiveOpsMarketDataCollectorCheck[];
}

/**
 * live ops market data collector의 검증/저장 실패다.
 *
 * 책임:
 * - event source가 production market/provider 계약을 벗어났을 때 DB write 전에 중단한다.
 * - 오류 메시지는 운영자 summary로 낮춰지고, raw provider payload는 보존하지 않는다.
 */
export class LiveOpsMarketDataCollectorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LiveOpsMarketDataCollectorError";
  }
}

/**
 * production live ops market data event를 DB-backed store에 저장하고 안전 요약을 만든다.
 *
 * @param input production live ops config, market data event source, DB-backed store
 * @returns collector readiness와 저장 count를 담은 secret-free summary
 */
export async function collectLiveOpsMarketData(
  input: CollectLiveOpsMarketDataInput,
): Promise<LiveOpsMarketDataCollectorSummary> {
  const config = loadLiveOpsConfig(input.config);
  const market = config.universe.default_market as MarketCode;
  const checks: LiveOpsMarketDataCollectorCheck[] = [
    okCheck("config", "production live ops market data 설정을 확인했습니다.", "live_ops_market_data_config_ok", {
      provider: config.market_data.provider,
      market,
    }),
  ];
  const sourceProfile = input.sourceProfile ?? "upbit_public";
  const state: MarketDataCollectorState = {
    market,
    latestHeartbeatAt: null,
  };

  try {
    const persisted = await persistMarketDataRuntimeEvents(
      input.store,
      validateLiveOpsMarketDataEvents(input.events, config, state),
      createPersistenceOptions(input),
    );

    checks.push(okCheck("event_source", "market data event source를 production market 기준으로 검증했습니다.", "live_ops_market_data_source_ok", {
      market,
      eventCount: persisted.eventCount,
    }));
    checks.push(okCheck("persistence", "market data event를 DB-backed store 경계로 저장했습니다.", "live_ops_market_data_persistence_ok", {
      tradeCount: persisted.tradeCount,
      orderbookCount: persisted.orderbookCount,
      statusCount: persisted.statusCount,
    }));

    if (persisted.tradeCount + persisted.orderbookCount === 0) {
      // 시세 이벤트 없이 status만 있으면 strategy/decision 입력을 만들 수 없어 다음 lifecycle로 넘기지 않는다.
      checks.push(blockedCheck("freshness", "체결 또는 호가 event가 아직 저장되지 않았습니다.", "live_ops_market_data_event_missing"));
    } else if (persisted.riskBlockCount > 0) {
      // stale/reconnect/disconnect는 신규 주문 차단 근거이므로 collector는 저장하되 ready로 올리지 않는다.
      checks.push(blockedCheck("freshness", "시세 지연 또는 연결 장애가 감지되어 신규 실주문으로 진행하지 않습니다.", "live_ops_market_data_risk_block", {
        riskBlockCount: persisted.riskBlockCount,
      }));
    } else {
      checks.push(okCheck("freshness", "체결/호가 event가 저장됐고 차단 상태가 없습니다.", "live_ops_market_data_fresh"));
    }

    return buildSummary(config, sourceProfile, checks, persisted, state.latestHeartbeatAt);
  } catch (error) {
    const persisted = emptyPersistenceSummary();
    checks.push(blockedCheck(
      "event_source",
      "market data event source가 production live ops 계약을 통과하지 못했습니다.",
      "live_ops_market_data_source_invalid",
      { reason: safeErrorName(error) },
    ));
    return buildSummary(config, sourceProfile, checks, persisted, state.latestHeartbeatAt);
  }
}

interface MarketDataCollectorState {
  readonly market: MarketCode;
  latestHeartbeatAt: string | null;
}

async function* validateLiveOpsMarketDataEvents(
  events: AsyncIterable<MarketDataRuntimeEvent>,
  config: LiveOpsConfig,
  state: MarketDataCollectorState,
): AsyncIterable<MarketDataRuntimeEvent> {
  const allowedMarkets = new Set(config.universe.markets);

  for await (const event of events) {
    if (event.exchangeId !== "upbit_krw_spot") {
      throw new LiveOpsMarketDataCollectorError("market data event exchange must be upbit_krw_spot");
    }

    if (event.type !== "STATUS" && !allowedMarkets.has(event.market)) {
      // 허용 market 밖 event는 잘못된 주문 판단 입력이 될 수 있어 DB write 전에 차단한다.
      throw new LiveOpsMarketDataCollectorError("market data event market is outside production universe");
    }

    if (event.type === "STATUS") {
      validateStatusEventMarket(event, allowedMarkets);
      state.latestHeartbeatAt = timestampToIsoString(event.observedAt);
    } else {
      state.latestHeartbeatAt = timestampToIsoString(event.receivedAt);
    }

    yield event;
  }
}

function createPersistenceOptions(
  input: CollectLiveOpsMarketDataInput,
): {
  workerId: string;
  orderbook?: MarketDataRuntimeOrderbookPersistenceOptions;
} {
  const options: {
    workerId: string;
    orderbook?: MarketDataRuntimeOrderbookPersistenceOptions;
  } = {
    workerId: input.workerId ?? "live-ops-market-data",
  };

  if (input.orderbook !== undefined) {
    options.orderbook = input.orderbook;
  }

  return options;
}

function validateStatusEventMarket(
  event: MarketDataStatusEvent,
  allowedMarkets: ReadonlySet<string>,
): void {
  if (event.market !== undefined && !allowedMarkets.has(event.market)) {
    // status event도 market이 붙어 있으면 같은 production universe 기준을 지켜야 한다.
    throw new LiveOpsMarketDataCollectorError("market data status market is outside production universe");
  }
}

function buildSummary(
  config: LiveOpsConfig,
  sourceProfile: LiveOpsMarketDataSourceProfile,
  checks: readonly LiveOpsMarketDataCollectorCheck[],
  persisted: MarketDataRuntimePersistenceSummary,
  latestHeartbeatAt: string | null,
): LiveOpsMarketDataCollectorSummary {
  const ready = checks.every((check) => check.status === "ok");
  return {
    status: ready ? "ready" : "blocked",
    ready,
    provider: "UPBIT_PUBLIC",
    market: config.universe.default_market as MarketCode,
    sourceProfile,
    message: ready
      ? "market data collector가 DB-backed 저장 경계를 통과했습니다."
      : "market data collector가 live ops 다음 단계로 진행할 수 없습니다.",
    latestHeartbeatAt,
    persisted,
    checks,
  };
}

function emptyPersistenceSummary(): MarketDataRuntimePersistenceSummary {
  return {
    eventCount: 0,
    tradeCount: 0,
    orderbookCount: 0,
    statusCount: 0,
    riskBlockCount: 0,
  };
}

function okCheck(
  name: LiveOpsMarketDataCollectorCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsMarketDataCollectorCheck {
  const check: LiveOpsMarketDataCollectorCheck = {
    name,
    status: "ok",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function blockedCheck(
  name: LiveOpsMarketDataCollectorCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsMarketDataCollectorCheck {
  const check: LiveOpsMarketDataCollectorCheck = {
    name,
    status: "blocked",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function timestampToIsoString(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}
