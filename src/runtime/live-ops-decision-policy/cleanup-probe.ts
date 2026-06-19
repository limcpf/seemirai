import { Decimal } from "decimal.js";
import type {
  JsonRecord,
  MarketDataEvent,
  NumericString,
  OrderIntent,
  OrderbookEvent,
  Strategy,
  StrategyContext,
  StrategyDecision,
} from "../../domain/index.js";

export const LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID = "live_ops_cleanup_probe";
const minimumUpbitKrwOrderNotional = new Decimal(5_000);
const runtimePreflightDateScope = "runtime_preflight_day";

/**
 * issue #206 cleanup probe strategy가 사용하는 non-secret sizing 정책이다.
 *
 * 책임:
 * - live ops JSON의 decision policy 값을 broker side effect 없는 전략 입력으로 낮춘다.
 * - 가격/수량/손실 입력을 코드 상수 대신 검증된 운영 정책으로 재현 가능하게 만든다.
 *
 * invariant:
 * - `maxNotionalKrw`는 production small-budget 단일 주문 상한을 넘기지 않아야 한다.
 * - `tickSizeKrw`와 `priceOffsetTicks`는 post-only BUY 후보가 best bid를 그대로 재사용하지 않게 하는 보수적 offset이다.
 *
 * side effect:
 * - 없음. 이 타입은 strategy factory 입력이며 DB, Upbit, Telegram을 호출하지 않는다.
 */
export interface LiveOpsCleanupProbeStrategyOptions {
  readonly maxNotionalKrw: NumericString;
  readonly tickSizeKrw: NumericString;
  readonly priceOffsetTicks: number;
  readonly quantityScale: number;
  readonly expectedLossBpsOfEquity: NumericString;
}

/**
 * issue #206 실거래 cleanup lifecycle을 증명하기 위한 전용 one-shot strategy를 만든다.
 *
 * @param options secret이 아닌 sizing/policy 입력
 * @returns `StrategyDecision`만 반환하는 broker side effect 없는 strategy 구현체
 *
 * invariant:
 * - strategy는 `KRW-BTC`, `upbit_krw_spot`, `BUY + LIMIT + POST_ONLY` 후보만 만든다.
 * - 최신 orderbook이 없거나 sizing 결과가 최소 주문금액/예산/호가 단위를 만족하지 못하면 주문 후보 대신 HOLD/BLOCK으로 닫는다.
 */
export function createLiveOpsCleanupProbeStrategy(options: LiveOpsCleanupProbeStrategyOptions): Strategy {
  const normalizedOptions = normalizeCleanupProbeOptions(options);

  return {
    id: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    version: "1",
    requiredFeatures: [],
    evaluate: (context) => evaluateCleanupProbe(context, normalizedOptions),
  };
}

function evaluateCleanupProbe(
  context: StrategyContext,
  options: NormalizedCleanupProbeOptions,
): StrategyDecision {
  if (context.exchangeId !== "upbit_krw_spot" || context.market !== "KRW-BTC") {
    // production cleanup probe는 BTC 단일 universe 증거만 만들기 때문에 다른 시장 context는 후보 생성 전에 차단한다.
    return block("cleanup_probe_scope_mismatch", {
      exchange_id: context.exchangeId,
      market: context.market,
    });
  }

  const orderbook = selectLatestOrderbook(context.marketEvents, context.market);
  if (orderbook === undefined) {
    // 호가가 없으면 post-only 가격을 재현할 수 없어 주문 없음으로 닫고 다음 market data tick을 기다린다.
    return hold("cleanup_probe_orderbook_missing", {
      market: context.market,
    });
  }

  const sizing = createCleanupProbeSizing(orderbook, options);
  if (sizing.kind === "blocked") {
    return block(sizing.reasonCode, sizing.metadata);
  }

  const intent: OrderIntent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    idempotencyKey: createCleanupProbeIdempotencyKey({
      dateScope: runtimePreflightDateScope,
      requestedPrice: sizing.requestedPrice,
      requestedQuantity: sizing.requestedQuantity,
      requestedNotional: sizing.requestedNotional,
    }),
    reason: "issue_206_cleanup_probe",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      source: "live_ops_cleanup_probe",
      issue: "206",
      expected_loss_bps_of_equity: options.expectedLossBpsOfEquity.toFixed(),
      best_bid_price: sizing.bestBidPrice,
      idempotency_date_scope: runtimePreflightDateScope,
      idempotency_date_source: "live_ops_runtime_preflight",
      strategy_observed_at: String(context.observedAt),
      tick_size_krw: options.tickSizeKrw.toFixed(),
      price_offset_ticks: options.priceOffsetTicks,
      policy_id: "cleanup_probe",
    },
  };

  return {
    kind: "ORDER_INTENT",
    strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    reason: "issue_206_cleanup_probe",
    orderIntents: [intent],
    metadata: {
      source: "live_ops_cleanup_probe",
      intent_count: 1,
      requested_notional_krw: sizing.requestedNotional,
    },
  };
}

interface NormalizedCleanupProbeOptions {
  readonly maxNotionalKrw: Decimal;
  readonly tickSizeKrw: Decimal;
  readonly priceOffsetTicks: number;
  readonly quantityScale: number;
  readonly expectedLossBpsOfEquity: Decimal;
}

function normalizeCleanupProbeOptions(options: LiveOpsCleanupProbeStrategyOptions): NormalizedCleanupProbeOptions {
  return {
    maxNotionalKrw: readPositiveDecimal(options.maxNotionalKrw, "maxNotionalKrw"),
    tickSizeKrw: readPositiveDecimal(options.tickSizeKrw, "tickSizeKrw"),
    priceOffsetTicks: readPositiveInteger(options.priceOffsetTicks, "priceOffsetTicks"),
    quantityScale: readPositiveInteger(options.quantityScale, "quantityScale"),
    expectedLossBpsOfEquity: readNonNegativeDecimal(options.expectedLossBpsOfEquity, "expectedLossBpsOfEquity"),
  };
}

function selectLatestOrderbook(
  events: readonly MarketDataEvent[],
  market: string | undefined,
): OrderbookEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "ORDERBOOK" && event.exchangeId === "upbit_krw_spot" && event.market === market) {
      return event;
    }
  }

  return undefined;
}

function createCleanupProbeSizing(
  orderbook: OrderbookEvent,
  options: NormalizedCleanupProbeOptions,
): {
  readonly kind: "ok";
  readonly bestBidPrice: NumericString;
  readonly requestedPrice: NumericString;
  readonly requestedQuantity: NumericString;
  readonly requestedNotional: NumericString;
} | {
  readonly kind: "blocked";
  readonly reasonCode: string;
  readonly metadata: JsonRecord;
} {
  const bestBid = readBestBid(orderbook);
  if (bestBid === undefined) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_best_bid_missing",
      metadata: { bid_level_count: orderbook.bids.length },
    };
  }

  const requestedPrice = bestBid.minus(options.tickSizeKrw.mul(options.priceOffsetTicks));
  if (!requestedPrice.gt(0) || !requestedPrice.mod(options.tickSizeKrw).isZero()) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_requested_price_invalid",
      metadata: {
        best_bid_price: bestBid.toFixed(),
        tick_size_krw: options.tickSizeKrw.toFixed(),
        price_offset_ticks: options.priceOffsetTicks,
      },
    };
  }

  const requestedQuantity = options.maxNotionalKrw
    .div(requestedPrice)
    .toDecimalPlaces(options.quantityScale, Decimal.ROUND_DOWN);
  const requestedNotional = requestedPrice.mul(requestedQuantity);

  if (!requestedQuantity.gt(0) || requestedNotional.lt(minimumUpbitKrwOrderNotional)) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_notional_below_minimum",
      metadata: {
        requested_notional_krw: requestedNotional.toFixed(),
        minimum_order_notional_krw: minimumUpbitKrwOrderNotional.toFixed(),
      },
    };
  }

  if (requestedNotional.gt(options.maxNotionalKrw)) {
    return {
      kind: "blocked",
      reasonCode: "cleanup_probe_notional_above_budget",
      metadata: {
        requested_notional_krw: requestedNotional.toFixed(),
        max_notional_krw: options.maxNotionalKrw.toFixed(),
      },
    };
  }

  return {
    kind: "ok",
    bestBidPrice: bestBid.toFixed() as NumericString,
    requestedPrice: requestedPrice.toFixed() as NumericString,
    requestedQuantity: requestedQuantity.toFixed() as NumericString,
    requestedNotional: requestedNotional.toFixed() as NumericString,
  };
}

function readBestBid(orderbook: OrderbookEvent): Decimal | undefined {
  const bids = orderbook.bids
    .map((level) => toOptionalDecimal(level.price))
    .filter((price): price is Decimal => price !== undefined)
    .toSorted((left, right) => right.comparedTo(left));

  return bids[0];
}

function createCleanupProbeIdempotencyKey(input: {
  readonly dateScope: string;
  readonly requestedPrice: NumericString;
  readonly requestedQuantity: NumericString;
  readonly requestedNotional: NumericString;
}): string {
  return [
    LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    input.dateScope,
    "upbit_krw_spot",
    "KRW-BTC",
    "BUY",
    input.requestedPrice,
    input.requestedQuantity,
    input.requestedNotional,
  ].join(":");
}

function hold(reason: string, metadata: JsonRecord): StrategyDecision {
  return {
    kind: "HOLD",
    strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    reason,
    metadata,
  };
}

function block(reasonCode: string, metadata: JsonRecord): StrategyDecision {
  return {
    kind: "BLOCK",
    strategyId: LIVE_OPS_CLEANUP_PROBE_STRATEGY_ID,
    reason: reasonCode,
    reasonCode,
    metadata,
  };
}

function readPositiveDecimal(value: string, field: string): Decimal {
  const decimal = toOptionalDecimal(value);
  if (decimal === undefined || !decimal.gt(0)) {
    throw new Error(`LiveOpsCleanupProbeInvalidPositiveDecimal:${field}`);
  }
  return decimal;
}

function readNonNegativeDecimal(value: string, field: string): Decimal {
  const decimal = toOptionalDecimal(value);
  if (decimal === undefined || decimal.lt(0)) {
    throw new Error(`LiveOpsCleanupProbeInvalidNonNegativeDecimal:${field}`);
  }
  return decimal;
}

function readPositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`LiveOpsCleanupProbeInvalidPositiveInteger:${field}`);
  }
  return value;
}

function toOptionalDecimal(value: unknown): Decimal | undefined {
  try {
    const decimal = new Decimal(String(value));
    return decimal.isFinite() ? decimal : undefined;
  } catch {
    return undefined;
  }
}
