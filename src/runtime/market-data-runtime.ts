import type { Insertable } from "kysely";
import type {
  JsonRecord,
  MarketCode,
  MarketDataConnectionStatus,
  MarketDataStatusEvent,
  MarketDataStreamRequest,
  OrderbookEvent,
  TradeEvent,
} from "../domain/index.js";
import {
  UPBIT_QUOTATION_WEBSOCKET_URL,
  UpbitQuotationWebSocketClient,
  serializeUpbitWebSocketRequest,
} from "../infrastructure/upbit/index.js";
import {
  insertTrade,
  upsertOrderbookMetric,
  upsertOrderbookSnapshot,
} from "../infrastructure/db/market-data.js";
import type {
  OrderbookMetricInputOptions,
  OrderbookSnapshotInputOptions,
} from "../infrastructure/db/market-data.js";
import type { Database } from "../infrastructure/db/database.js";
import type { AuditEventsTable, RiskEventsTable } from "../infrastructure/db/schema.js";
import { loadRuntimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { resolveRegistryActivationConfig } from "./registry-config.js";
import type { RegistryActivationResolution } from "./registry-config.js";

export const PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID = "paper-no-key-market-data-worker";
export const MARKET_DATA_STATUS_AUDIT_EVENT_TYPE = "MARKET_DATA_STATUS";
export const MARKET_DATA_BLOCK_NEW_ORDERS_ACTION = "BLOCK_NEW_ORDERS";

/**
 * M3 runtime persistence가 직접 저장하는 market data event 범위다.
 *
 * ticker는 아직 저장 테이블이 없으므로 이 union에서 제외하고, 체결/호가/status만 명시적으로 처리한다.
 */
export type MarketDataRuntimeEvent = TradeEvent | OrderbookEvent | MarketDataStatusEvent;

/**
 * market data status를 `audit_events`에 남기기 위한 insert row다.
 *
 * public type으로 노출해 테스트와 후속 audit repository가 같은 row contract를 재사용할 수 있게 한다.
 */
export type MarketDataStatusAuditRow = Insertable<AuditEventsTable>;

/**
 * market data status를 `risk_events` 신규 주문 차단 후보로 남기기 위한 insert row다.
 *
 * M5 RiskGate 구현 전까지 stale/reconnect/disconnect 신호의 저장 contract를 이 타입으로 고정한다.
 */
export type MarketDataStatusRiskRow = Insertable<RiskEventsTable>;

/**
 * `PAPER_NO_KEY` market data runtime 조립 실패다.
 *
 * config schema는 일반 runtime 안전 toggle을 검증하고, 이 오류는 Upbit public quotation stream만 써야 하는
 * M3 전용 조립 조건을 추가로 검증한다. 위반 항목은 PR 검증과 운영 로그에서 바로 확인할 수 있게 문자열로 보존한다.
 */
export class UnsafePaperNoKeyMarketDataRuntimeError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe PAPER_NO_KEY market data runtime: ${violations.join(", ")}`);
    this.name = "UnsafePaperNoKeyMarketDataRuntimeError";
    this.violations = violations;
  }
}

/**
 * Upbit `PAPER_NO_KEY` market data runtime 조립 옵션이다.
 *
 * consumerId는 WebSocket ticket에 들어가는 업무 식별자이며, 주문/잔고 API 인증 정보가 아니라 공개 quotation
 * stream 소비자를 구분하는 값이다.
 */
export interface PaperNoKeyMarketDataRuntimeOptions {
  consumerId?: string;
  orderbookLevel?: string;
}

/**
 * `PAPER_NO_KEY` market data runtime 조립 결과다.
 *
 * runtime worker는 이 값의 stream request와 subscription message만 사용해 Upbit 공개 체결/호가 수집을 시작한다.
 * 메시지에는 API key, Authorization header, private endpoint 후보가 없어야 하며 단위 테스트가 그 불변식을 검증한다.
 */
export interface PaperNoKeyMarketDataRuntime {
  config: RuntimeConfig;
  registry: RegistryActivationResolution;
  exchangeId: string;
  markets: readonly MarketCode[];
  publicQuotationEndpoint: string;
  tradeStreamRequest: MarketDataStreamRequest;
  orderbookStreamRequest: MarketDataStreamRequest;
  tradeSubscriptionMessage: string;
  orderbookSubscriptionMessage: string;
}

/**
 * orderbook event 저장 시 metric과 snapshot 저장 옵션을 분리한다.
 *
 * M3 worker는 1초 metric과 5초 snapshot을 함께 남기지만, 테스트와 replay는 lag/reconnect count 같은 metric
 * 보조값만 주입할 수 있어야 한다.
 */
export interface MarketDataRuntimeOrderbookPersistenceOptions {
  metric?: OrderbookMetricInputOptions;
  snapshot?: OrderbookSnapshotInputOptions;
}

/**
 * market data status row 생성에 필요한 runtime 문맥이다.
 *
 * workerId와 correlationId는 audit/risk table에서 같은 WebSocket 상태 변화가 어떤 worker 흐름에서 나왔는지
 * 추적하기 위한 값이다.
 */
export interface MarketDataStatusPersistenceContext {
  workerId?: string;
  correlationId?: string;
}

/**
 * market data event 저장소가 제공해야 하는 최소 write surface다.
 *
 * runtime worker는 이 interface만 보고 trade, orderbook, status를 저장한다. 실제 PostgreSQL 구현은 아래
 * factory에서 연결하고, 단위 테스트는 fake store로 저장 순서와 차단 신호를 검증한다.
 */
export interface MarketDataRuntimeEventStore {
  saveTrade(event: TradeEvent): Promise<void>;
  saveOrderbook(event: OrderbookEvent, options: MarketDataRuntimeOrderbookPersistenceOptions): Promise<void>;
  appendStatusAudit(row: MarketDataStatusAuditRow): Promise<void>;
  appendStatusRisk(row: MarketDataStatusRiskRow): Promise<void>;
}

/**
 * runtime persistence가 side effect로 쓰는 저장소 대상이다.
 *
 * PR 검증에서는 이 값을 통해 event type별 DB write 범위가 커지거나 줄어드는지 확인한다.
 */
export type MarketDataRuntimeWriteTarget =
  | "trades"
  | "orderbook_metrics"
  | "orderbook_snapshots"
  | "audit_events"
  | "risk_events";

/**
 * 단일 market data event를 저장할 때 기대되는 write 계획이다.
 *
 * M3 runtime 검증은 실제 RiskGate state machine을 만들지 않고, 어떤 event가 신규 주문 차단 입력으로 전환되는지
 * 이 계획과 risk row 후보로 고정한다.
 */
export interface MarketDataRuntimePersistencePlan {
  eventType: MarketDataRuntimeEvent["type"];
  writes: readonly MarketDataRuntimeWriteTarget[];
  blockNewOrders: boolean;
}

/**
 * async market data stream 저장 결과 요약이다.
 *
 * fixture replay나 local smoke run은 이 카운터로 체결/호가/status가 모두 runtime persistence 경계를 지났는지
 * 확인한다.
 */
export interface MarketDataRuntimePersistenceSummary {
  eventCount: number;
  tradeCount: number;
  orderbookCount: number;
  statusCount: number;
  riskBlockCount: number;
}

/**
 * 기본 paper profile을 Upbit 공개 market data runtime으로 조립한다.
 *
 * 흐름은 runtime config 검증, registry resolution, WebSocket stream request 생성, 공개 quotation subscription
 * 직렬화 순서다. 인증 API나 private stream을 만들 수 있는 입력이 발견되면 fail-fast한다.
 */
export function createPaperNoKeyMarketDataRuntime(
  input: unknown,
  options: PaperNoKeyMarketDataRuntimeOptions = {},
): PaperNoKeyMarketDataRuntime {
  const config = assertPaperNoKeyMarketDataRuntimeConfig(loadRuntimeConfig(input));
  const registry = resolveRegistryActivationConfig(config.registry);
  const exchangeId = registry.exchange.id;
  const consumerId = options.consumerId ?? PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID;
  const tradeStreamRequest: MarketDataStreamRequest = {
    exchangeId,
    markets: config.universe.phase_1,
    consumerId,
  };
  const orderbookStreamRequest: MarketDataStreamRequest = {
    exchangeId,
    markets: config.universe.phase_1,
    consumerId,
  };
  const client = new UpbitQuotationWebSocketClient();
  const tradeSubscriptionMessage = serializeUpbitWebSocketRequest(
    client.createTradeSubscription(tradeStreamRequest, {
      isOnlyRealtime: true,
    }),
  );
  const orderbookSubscriptionMessage = serializeUpbitWebSocketRequest(
    client.createOrderbookSubscription(orderbookStreamRequest, {
      isOnlyRealtime: true,
      ...(options.orderbookLevel === undefined ? {} : { level: options.orderbookLevel }),
    }),
  );

  assertPublicQuotationRuntimeMessages([tradeSubscriptionMessage, orderbookSubscriptionMessage]);

  return {
    config,
    registry,
    exchangeId,
    markets: config.universe.phase_1,
    publicQuotationEndpoint: UPBIT_QUOTATION_WEBSOCKET_URL,
    tradeStreamRequest,
    orderbookStreamRequest,
    tradeSubscriptionMessage,
    orderbookSubscriptionMessage,
  };
}

/**
 * `PAPER_NO_KEY` market data runtime 전용 안전 조건을 검증한다.
 *
 * 기본 runtime guard가 실거래/출금/시장가 주문 toggle을 막고, 이 guard는 Upbit API key와 인증 profile이
 * market data worker에 섞이는 것을 차단한다.
 */
export function assertPaperNoKeyMarketDataRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const violations: string[] = [];

  if (config.exchange !== "UPBIT" || config.market !== "KRW_SPOT" || config.mode !== "PAPER_TRADING") {
    violations.push("market data runtime must use UPBIT KRW_SPOT PAPER_TRADING");
  }

  if (!config.paper_no_key) {
    violations.push("market data runtime must use PAPER_NO_KEY");
  }

  if (config.registry.exchangeId !== "upbit_krw_spot") {
    violations.push("market data runtime must resolve upbit_krw_spot registry entry");
  }

  if (config.secrets.upbit_access_key !== undefined || config.secrets.upbit_secret_key !== undefined) {
    violations.push("PAPER_NO_KEY market data runtime must not include Upbit API keys");
  }

  if (violations.length > 0) {
    throw new UnsafePaperNoKeyMarketDataRuntimeError(violations);
  }

  return config;
}

/**
 * PostgreSQL 기반 market data event store를 만든다.
 *
 * trade와 orderbook은 PR3 repository를 재사용하고, status는 M5 RiskGate 구현 전까지 audit/risk table에
 * 차단 후보 row로 남긴다.
 */
export function createDatabaseMarketDataRuntimeEventStore(database: Database): MarketDataRuntimeEventStore {
  return {
    saveTrade: async (event) => {
      await insertTrade(database, event);
    },
    saveOrderbook: async (event, options) => {
      await upsertOrderbookMetric(database, event, options.metric);
      await upsertOrderbookSnapshot(database, event, options.snapshot);
    },
    appendStatusAudit: async (row) => {
      await database.insertInto("audit_events").values(row).execute();
    },
    appendStatusRisk: async (row) => {
      await database.insertInto("risk_events").values(row).execute();
    },
  };
}

/**
 * market data event 하나를 runtime persistence 경계로 흘려보낸다.
 *
 * 체결은 `trades`, 호가는 `orderbook_metrics`와 `orderbook_snapshots`, 상태는 `audit_events`와 필요 시
 * `risk_events`로 라우팅한다. `STALE`, `RECONNECTING`, `DISCONNECTED`는 신규 주문 차단 신호로 표시한다.
 */
export async function persistMarketDataRuntimeEvent(
  store: MarketDataRuntimeEventStore,
  event: MarketDataRuntimeEvent,
  options: MarketDataStatusPersistenceContext & {
    orderbook?: MarketDataRuntimeOrderbookPersistenceOptions;
  } = {},
): Promise<MarketDataRuntimePersistencePlan> {
  const plan = planMarketDataRuntimePersistence(event);

  if (event.type === "TRADE") {
    await store.saveTrade(event);
    return plan;
  }

  if (event.type === "ORDERBOOK") {
    await store.saveOrderbook(event, options.orderbook ?? {});
    return plan;
  }

  await store.appendStatusAudit(toMarketDataStatusAuditRow(event, options));

  const riskRow = toMarketDataStatusRiskRow(event, options);
  if (riskRow !== undefined) {
    await store.appendStatusRisk(riskRow);
  }

  return plan;
}

/**
 * async market data stream 전체를 runtime store에 저장한다.
 *
 * WebSocket replay와 실제 worker loop가 같은 함수를 쓸 수 있게 async iterable만 입력으로 받는다. 반환 summary는
 * PR 검증에서 stale/reconnect/disconnect가 risk block 후보로 세어졌는지 확인하는 증거가 된다.
 */
export async function persistMarketDataRuntimeEvents(
  store: MarketDataRuntimeEventStore,
  events: AsyncIterable<MarketDataRuntimeEvent>,
  options: MarketDataStatusPersistenceContext & {
    orderbook?: MarketDataRuntimeOrderbookPersistenceOptions;
  } = {},
): Promise<MarketDataRuntimePersistenceSummary> {
  const summary: MarketDataRuntimePersistenceSummary = {
    eventCount: 0,
    tradeCount: 0,
    orderbookCount: 0,
    statusCount: 0,
    riskBlockCount: 0,
  };

  for await (const event of events) {
    const plan = await persistMarketDataRuntimeEvent(store, event, options);
    summary.eventCount += 1;

    if (event.type === "TRADE") {
      summary.tradeCount += 1;
    } else if (event.type === "ORDERBOOK") {
      summary.orderbookCount += 1;
    } else {
      summary.statusCount += 1;
    }

    if (plan.blockNewOrders) {
      summary.riskBlockCount += 1;
    }
  }

  return summary;
}

/**
 * market data event가 어떤 저장소에 기록될지 계산한다.
 *
 * 이 함수는 side effect가 없어 unit test에서 runtime 저장 정책을 검증한다. M5가 실제 RiskGate state machine을
 * 추가하더라도 M3의 event-to-signal contract는 이 계획을 기준으로 유지한다.
 */
export function planMarketDataRuntimePersistence(
  event: MarketDataRuntimeEvent,
): MarketDataRuntimePersistencePlan {
  if (event.type === "TRADE") {
    return {
      eventType: "TRADE",
      writes: ["trades"],
      blockNewOrders: false,
    };
  }

  if (event.type === "ORDERBOOK") {
    return {
      eventType: "ORDERBOOK",
      writes: ["orderbook_metrics", "orderbook_snapshots"],
      blockNewOrders: false,
    };
  }

  return {
    eventType: "STATUS",
    writes: marketDataStatusBlocksNewOrders(event.status)
      ? ["audit_events", "risk_events"]
      : ["audit_events"],
    blockNewOrders: marketDataStatusBlocksNewOrders(event.status),
  };
}

/**
 * market data status를 audit_events insert row로 변환한다.
 *
 * 모든 연결 상태는 audit에 남긴다. `CONNECTED`도 복구 근거가 되므로 INFO로 기록하고, 장애성 상태는 사람이
 * 운영 흐름을 추적할 수 있게 reason/lag/reconnect metadata를 payload에 보존한다.
 */
export function toMarketDataStatusAuditRow(
  event: MarketDataStatusEvent,
  context: MarketDataStatusPersistenceContext = {},
): MarketDataStatusAuditRow {
  return {
    event_type: MARKET_DATA_STATUS_AUDIT_EVENT_TYPE,
    severity: toAuditSeverity(event.status),
    order_id: null,
    correlation_id: context.correlationId ?? toStatusCorrelationId(event),
    payload_json: toMarketDataStatusPayload(event, context),
    occurred_at: event.observedAt,
  };
}

/**
 * market data status를 risk_events insert row 후보로 변환한다.
 *
 * `CONNECTED`는 차단 사유가 아니므로 risk row를 만들지 않는다. stale/reconnect/disconnect는 M5 RiskGate가
 * 소비할 신규 주문 차단 입력으로 `BLOCK_NEW_ORDERS` action을 남긴다.
 */
export function toMarketDataStatusRiskRow(
  event: MarketDataStatusEvent,
  context: MarketDataStatusPersistenceContext = {},
): MarketDataStatusRiskRow | undefined {
  if (!marketDataStatusBlocksNewOrders(event.status)) {
    return undefined;
  }

  return {
    risk_type: toRiskType(event.status),
    severity: toRiskSeverity(event.status),
    market: event.market ?? null,
    strategy_id: null,
    order_id: null,
    action: MARKET_DATA_BLOCK_NEW_ORDERS_ACTION,
    payload_json: toMarketDataStatusPayload(event, context),
    occurred_at: event.observedAt,
  };
}

/**
 * status 값이 신규 주문 차단 입력인지 판정한다.
 *
 * M3에서는 차단 상태를 상태 머신에 적용하지 않고, stale/reconnect/disconnect가 RiskGate 입력이라는 불변식만
 * 고정한다.
 */
export function marketDataStatusBlocksNewOrders(
  status: MarketDataConnectionStatus,
): status is Exclude<MarketDataConnectionStatus, "CONNECTED"> {
  return status === "STALE" || status === "RECONNECTING" || status === "DISCONNECTED";
}

function assertPublicQuotationRuntimeMessages(messages: readonly string[]): void {
  const forbiddenPatterns = [
    /authorization/iu,
    /\bbearer\b/iu,
    /\/private/iu,
    /\bmyOrder\b/u,
    /\bmyAsset\b/u,
    /orders\/chance/iu,
    /\/v1\/orders/iu,
  ];
  const violations = messages.flatMap((message) =>
    forbiddenPatterns.filter((pattern) => pattern.test(message)).map((pattern) => String(pattern)),
  );

  if (violations.length > 0) {
    throw new UnsafePaperNoKeyMarketDataRuntimeError([
      `public quotation subscription contains forbidden private/auth tokens: ${violations.join(", ")}`,
    ]);
  }
}

function toMarketDataStatusPayload(
  event: MarketDataStatusEvent,
  context: MarketDataStatusPersistenceContext,
): JsonRecord {
  return {
    kind: "market_data_status",
    exchangeId: event.exchangeId,
    status: event.status,
    blockNewOrders: marketDataStatusBlocksNewOrders(event.status),
    workerId: context.workerId ?? PAPER_NO_KEY_MARKET_DATA_CONSUMER_ID,
    ...(event.market === undefined ? {} : { market: event.market }),
    ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    ...(event.websocketLagMs === undefined ? {} : { websocketLagMs: event.websocketLagMs }),
    ...(event.reconnectCount === undefined ? {} : { reconnectCount: event.reconnectCount }),
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
  };
}

function toAuditSeverity(status: MarketDataConnectionStatus): AuditEventsTable["severity"] {
  if (status === "DISCONNECTED") {
    return "ERROR";
  }

  if (status === "STALE" || status === "RECONNECTING") {
    return "WARN";
  }

  return "INFO";
}

function toRiskSeverity(status: MarketDataConnectionStatus): RiskEventsTable["severity"] {
  return status === "DISCONNECTED" ? "ERROR" : "WARN";
}

function toRiskType(status: Exclude<MarketDataConnectionStatus, "CONNECTED">): string {
  if (status === "STALE") {
    return "stale_market_data";
  }

  if (status === "RECONNECTING") {
    return "market_data_reconnecting";
  }

  return "market_data_disconnected";
}

function toStatusCorrelationId(event: MarketDataStatusEvent): string {
  return [
    "market-data",
    event.exchangeId,
    event.market ?? "global",
    event.status,
    event.observedAt instanceof Date ? event.observedAt.toISOString() : event.observedAt,
  ].join(":");
}
