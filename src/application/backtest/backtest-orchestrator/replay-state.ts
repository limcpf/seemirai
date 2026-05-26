import type {
  MarketDataEvent,
  MarketEvent,
  MarketOrderbookSnapshotEvent,
  MarketPolicyCandidateEvent,
  MarketStatus,
  OrderIntent,
  OrderbookEvent,
} from "../../../domain/index.js";
import type { HistoricalEventReplayRequest } from "../../ports/index.js";
import type {
  BacktestCostInput,
  BacktestReplayHistoryLimits,
  BacktestReplayState,
  BacktestReplayStateSnapshot,
  BacktestRiskGateContextInput,
  BacktestRuleContextInput,
  BacktestRunRequest,
  NormalizedBacktestReplayHistoryLimits,
} from "./types.js";

const emptyOrderbookHistory: readonly OrderbookEvent[] = [];
const defaultReplayHistoryLimit = 10_000;

/**
 * BacktestRunRequest에서 HistoricalEventSource가 이해하는 replay request만 추출한다.
 *
 * callback, fill option, history limit 같은 orchestrator 전용 설정이 source port로 새지 않도록 경계를 분리한다.
 */
export function createReplayRequest(request: BacktestRunRequest): HistoricalEventReplayRequest {
  const replayRequest: HistoricalEventReplayRequest = {};

  if (request.exchangeId !== undefined) {
    replayRequest.exchangeId = request.exchangeId;
  }
  if (request.markets !== undefined) {
    replayRequest.markets = request.markets;
  }
  if (request.from !== undefined) {
    replayRequest.from = request.from;
  }
  if (request.to !== undefined) {
    replayRequest.to = request.to;
  }
  if (request.sourceId !== undefined) {
    replayRequest.sourceId = request.sourceId;
  }
  if (request.limit !== undefined) {
    replayRequest.limit = request.limit;
  }

  return replayRequest;
}

/**
 * replay loop가 사용할 빈 mutable state를 만든다.
 *
 * 이 state는 orchestrator 내부에서만 변경되고 callback에는 snapshot 복사본만 전달되어야 한다.
 */
export function createReplayState(): BacktestReplayState {
  return {
    latestMarketDataEvents: [],
    latestOrderbooksByMarketKey: new Map(),
    latestMarketStatusesByMarketKey: new Map(),
    orderbookHistoryByMarketKey: new Map(),
  };
}

/**
 * replay event를 strategy callback state window에 반영한다.
 *
 * 결과 이벤트 목록은 별도로 유지하고, 이 mutable state는 최신 market data/status/orderbook과 제한된 orderbook history만 보존한다.
 */
export function updateReplayState(
  state: BacktestReplayState,
  event: MarketEvent,
  historyLimits: NormalizedBacktestReplayHistoryLimits,
): void {
  const marketDataEvent = toMarketDataEvent(event);
  if (marketDataEvent !== undefined) {
    state.latestMarketDataEvents.push(marketDataEvent);
    trimArrayStart(state.latestMarketDataEvents, historyLimits.marketDataEvents);
  }

  if (event.kind === "ORDERBOOK_SNAPSHOT") {
    const orderbook = toOrderbookEvent(event);
    const marketKey = createMarketKey(event.exchangeId, event.market);
    state.latestOrderbooksByMarketKey.set(marketKey, orderbook);
    const history = getOrCreateOrderbookHistory(state, marketKey);
    history.push(orderbook);
    trimArrayStart(history, historyLimits.orderbooksPerMarket);
  }

  if (event.kind === "POLICY_CANDIDATE") {
    state.latestMarketStatusesByMarketKey.set(createMarketKey(event.exchangeId, event.market), toMarketStatus(event));
  }
}

/**
 * 현재 replay state를 callback에 넘길 immutable snapshot으로 복사한다.
 *
 * intent가 있으면 intent 시장 기준의 orderbook/status/history를 선택해 다른 시장의 최신 호가가 후보 평가에 섞이지 않게 한다.
 */
export function snapshotReplayState(
  state: BacktestReplayState,
  event: MarketEvent,
  intent?: OrderIntent,
): BacktestReplayStateSnapshot {
  const targetExchangeId = intent?.exchangeId ?? event.exchangeId;
  const targetMarket = intent?.market ?? event.market;
  const marketKey = targetMarket === undefined ? undefined : createMarketKey(targetExchangeId, targetMarket);
  const latestOrderbook =
    marketKey === undefined ? undefined : state.latestOrderbooksByMarketKey.get(marketKey);
  const latestMarketStatus =
    marketKey === undefined ? undefined : state.latestMarketStatusesByMarketKey.get(marketKey);
  const orderbookHistory = marketKey === undefined ? emptyOrderbookHistory : getOrderbookHistoryByMarketKey(state, marketKey);

  return {
    latestMarketDataEvents: cloneReplayStateArray(state.latestMarketDataEvents),
    orderbookHistory: cloneReplayStateArray(orderbookHistory),
    ...(latestOrderbook === undefined ? {} : { latestOrderbook: cloneReplayStateValue(latestOrderbook) }),
    ...(latestMarketStatus === undefined ? {} : { latestMarketStatus: cloneReplayStateValue(latestMarketStatus) }),
  };
}

/**
 * 후보 intent 시장에 해당하는 orderbook history window를 조회한다.
 *
 * 다른 시장의 호가가 fill simulation에 섞이지 않도록 intent exchange/market을 우선한다.
 */
export function getOrderbookHistory(
  state: BacktestReplayState,
  event: MarketEvent,
  intent: OrderIntent,
): readonly OrderbookEvent[] {
  const targetMarket = intent.market ?? event.market;
  if (targetMarket === undefined) {
    return emptyOrderbookHistory;
  }

  return getOrderbookHistoryByMarketKey(state, createMarketKey(intent.exchangeId, targetMarket));
}

/**
 * optional history limit을 기본값이 적용된 양의 정수 설정으로 정규화한다.
 *
 * 잘못된 limit은 긴 backtest에서 메모리 보호가 깨지는 설정이므로 즉시 예외로 노출한다.
 */
export function normalizeReplayHistoryLimits(
  limits: BacktestReplayHistoryLimits | undefined,
): NormalizedBacktestReplayHistoryLimits {
  return {
    marketDataEvents: normalizeReplayHistoryLimit(limits?.marketDataEvents, "marketDataEvents"),
    orderbooksPerMarket: normalizeReplayHistoryLimit(limits?.orderbooksPerMarket, "orderbooksPerMarket"),
  };
}

/**
 * replay callback에 넘길 배열 값을 deep clone한다.
 *
 * 사용자 callback이 반환 후 배열 요소를 변경해 내부 replay state를 오염시키지 못하게 한다.
 */
export function cloneReplayStateArray<T>(items: readonly T[]): readonly T[] {
  return items.map(cloneReplayStateValue);
}

/**
 * replay state와 callback 입력 값을 structuredClone으로 복사한다.
 *
 * backtest는 side-effect-free callback 계약을 기대하므로 mutable 객체 공유를 피한다.
 */
export function cloneReplayStateValue<T>(value: T): T {
  return structuredClone(value) as T;
}

/**
 * callback state snapshot 전체를 deep clone한다.
 *
 * 비용/리스크/rule callback에 같은 후보 상태를 넘길 때 이전 callback mutation이 후속 판단에 영향을 주지 않게 한다.
 */
export function cloneReplayStateSnapshot(state: BacktestReplayStateSnapshot): BacktestReplayStateSnapshot {
  return {
    latestMarketDataEvents: cloneReplayStateArray(state.latestMarketDataEvents),
    orderbookHistory: cloneReplayStateArray(state.orderbookHistory),
    ...(state.latestOrderbook === undefined ? {} : { latestOrderbook: cloneReplayStateValue(state.latestOrderbook) }),
    ...(state.latestMarketStatus === undefined
      ? {}
      : { latestMarketStatus: cloneReplayStateValue(state.latestMarketStatus) }),
  };
}

/**
 * CostModel callback 입력을 후보 단위로 복사한다.
 *
 * strategy 객체와 context는 호출자가 소유한 runtime 계약을 유지하고, event/intent/state evidence만 clone한다.
 */
export function cloneBacktestCostInput(input: BacktestCostInput): BacktestCostInput {
  return {
    event: cloneReplayStateValue(input.event),
    strategy: input.strategy,
    strategyContext: input.strategyContext,
    decision: input.decision,
    conversion: input.conversion,
    intent: cloneReplayStateValue(input.intent),
    state: cloneReplayStateSnapshot(input.state),
  };
}

/**
 * RiskGate context callback 입력을 복사한다.
 *
 * costDecision을 포함해 RiskGate가 보는 후보 증거가 이전 callback mutation에 영향받지 않도록 한다.
 */
export function cloneBacktestRiskGateContextInput(input: BacktestRiskGateContextInput): BacktestRiskGateContextInput {
  return {
    ...cloneBacktestCostInput(input),
    costDecision: cloneReplayStateValue(input.costDecision),
  };
}

/**
 * RuleEngine context callback 입력을 복사한다.
 *
 * rule callback은 RiskGateContext를 읽기 전용으로 다뤄야 하므로 호출 직전에 별도 snapshot으로 분리한다.
 */
export function cloneBacktestRuleContextInput(input: BacktestRuleContextInput): BacktestRuleContextInput {
  return {
    ...cloneBacktestRiskGateContextInput(input),
    riskGateContext: cloneReplayStateValue(input.riskGateContext),
  };
}

function getOrderbookHistoryByMarketKey(state: BacktestReplayState, marketKey: string): readonly OrderbookEvent[] {
  return state.orderbookHistoryByMarketKey.get(marketKey) ?? emptyOrderbookHistory;
}

function getOrCreateOrderbookHistory(state: BacktestReplayState, marketKey: string): OrderbookEvent[] {
  const existingHistory = state.orderbookHistoryByMarketKey.get(marketKey);
  if (existingHistory !== undefined) {
    return existingHistory;
  }

  const history: OrderbookEvent[] = [];
  state.orderbookHistoryByMarketKey.set(marketKey, history);
  return history;
}

function normalizeReplayHistoryLimit(value: number | undefined, name: keyof BacktestReplayHistoryLimits): number {
  if (value === undefined) {
    return defaultReplayHistoryLimit;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`BacktestRunRequest.historyLimits.${name} must be a positive integer`);
  }

  return value;
}

function trimArrayStart<T>(items: T[], maxLength: number): void {
  const overflow = items.length - maxLength;
  if (overflow <= 0) {
    return;
  }

  // 오래된 replay state만 제거해 callback window와 pending fill window가 무한히 커지지 않게 한다.
  items.splice(0, overflow);
}

function toMarketDataEvent(event: MarketEvent): MarketDataEvent | undefined {
  switch (event.kind) {
    case "TRADE":
      return {
        type: "TRADE",
        exchangeId: event.exchangeId,
        market: event.market,
        tradeId: event.tradeId,
        price: event.price,
        quantity: event.quantity,
        side: event.side,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
        ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
      };
    case "ORDERBOOK_SNAPSHOT":
      return toOrderbookEvent(event);
    case "TICKER":
      return {
        type: "TICKER",
        exchangeId: event.exchangeId,
        market: event.market,
        tradePrice: event.tradePrice,
        exchangeTimestamp: event.eventTimestamp,
        receivedAt: event.receivedAt ?? event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
        ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
        ...(event.changeRate === undefined ? {} : { changeRate: event.changeRate }),
        ...(event.accTradePrice24h === undefined ? {} : { accTradePrice24h: event.accTradePrice24h }),
      };
    case "STATUS":
      return {
        type: "STATUS",
        exchangeId: event.exchangeId,
        status: event.status,
        observedAt: event.eventTimestamp,
        sequence: event.sequence,
        tieBreakKey: event.tieBreakKey,
        ...(event.market === undefined ? {} : { market: event.market }),
        ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
        ...(event.websocketLagMs === undefined ? {} : { websocketLagMs: event.websocketLagMs }),
        ...(event.reconnectCount === undefined ? {} : { reconnectCount: event.reconnectCount }),
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      };
    case "ORDERBOOK_METRIC":
    case "POLICY_CANDIDATE":
      return undefined;
  }
}

function toOrderbookEvent(event: MarketOrderbookSnapshotEvent): OrderbookEvent {
  return {
    type: "ORDERBOOK",
    exchangeId: event.exchangeId,
    market: event.market,
    asks: event.asks,
    bids: event.bids,
    exchangeTimestamp: event.eventTimestamp,
    receivedAt: event.receivedAt ?? event.eventTimestamp,
    sequence: event.sequence,
    tieBreakKey: event.tieBreakKey,
    ...(event.source.raw === undefined ? {} : { raw: event.source.raw }),
  };
}

function toMarketStatus(event: MarketPolicyCandidateEvent): MarketStatus {
  return {
    exchangeId: event.exchangeId,
    market: event.market,
    tradable: event.tradable,
    warning: event.warning,
    caution: event.caution,
    reasonCodes: event.reasonCodes,
    updatedAt: event.eventTimestamp,
  };
}

function createMarketKey(exchangeId: string, market: string): string {
  return JSON.stringify([exchangeId, market]);
}
