import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  JsonRecord,
  NumericString,
  OrderIntent,
  OrderLifecycleStatus,
  OrderbookEvent,
  OrderbookLevel,
  TimeInForce,
  TimestampInput,
} from "../../domain/index.js";

export type PaperFillLiquidity = "TAKER";

export type PaperFillPostOnlyTakerPolicy = "REJECT" | "PENDING";

export type PaperFillSimulationStatus =
  | "FILLED"
  | "PARTIALLY_FILLED"
  | "UNFILLED"
  | "POST_ONLY_REJECTED"
  | "POST_ONLY_PENDING"
  | "IOC_CANCELED"
  | "FOK_CANCELED"
  | "REJECTED";

export type PaperFillSimulationReasonCode =
  | "limit_crossed_full"
  | "limit_crossed_partial"
  | "limit_not_crossed"
  | "post_only_would_take_rejected"
  | "post_only_would_take_pending"
  | "ioc_filled_and_canceled"
  | "ioc_unfilled_canceled"
  | "fok_not_filled"
  | "market_order_simulation_disabled"
  | "latency_snapshot_missing"
  | "orderbook_snapshot_missing";

export interface PaperFillSimulatorOptions {
  /**
   * 주문 제출 시각이다.
   *
   * `latencyMs`가 0보다 크고 여러 orderbook snapshot이 들어오면 이 시각 이후 latency가 지난 첫 snapshot으로 체결을
   * 계산한다. 값이 없으면 첫 snapshot을 즉시 체결 기준으로 사용한다.
   */
  submittedAt?: TimestampInput;
  /** 주문 제출 후 체결 판단에 반영할 지연 시간이다. */
  latencyMs?: number;
  /** post-only 주문이 현재 orderbook에서 즉시 taker 체결될 때 거부할지, 대기 상태로 남길지 정한다. */
  postOnlyTakerPolicy?: PaperFillPostOnlyTakerPolicy;
  /** intent에 time-in-force가 없을 때 적용할 기본값이다. */
  defaultTimeInForce?: TimeInForce;
  /** 현재 orderbook을 즉시 소모하는 paper fill에 적용할 taker 수수료 bps다. */
  takerFeeBps?: NumericString;
}

export interface PaperFillSimulationInput {
  intent: OrderIntent;
  orderbooks: OrderbookEvent | readonly OrderbookEvent[];
  options?: PaperFillSimulatorOptions;
}

export interface PaperFill {
  price: NumericString;
  quantity: NumericString;
  notional: NumericString;
  fee: NumericString;
  liquidity: PaperFillLiquidity;
}

export interface PaperFillSimulationResult {
  status: PaperFillSimulationStatus;
  orderStatus: OrderLifecycleStatus;
  reasonCode: PaperFillSimulationReasonCode;
  requestedQuantity: NumericString;
  filledQuantity: NumericString;
  openQuantity: NumericString;
  canceledQuantity: NumericString;
  averageFillPrice?: NumericString;
  totalFillNotional?: NumericString;
  totalFee?: NumericString;
  slippageBps?: NumericString;
  fills: readonly PaperFill[];
  orderbookReceivedAt?: TimestampInput;
  metadata?: JsonRecord;
}

interface ExecutableDepthResult {
  fills: readonly PaperFill[];
  filledQuantity: NumericString;
  totalFillNotional: NumericString;
  totalFee: NumericString;
  averageFillPrice?: NumericString;
  slippageBps?: NumericString;
}

/**
 * PaperBroker가 사용할 orderbook depth 기반 순수 fill simulator다.
 *
 * 이 함수는 DB, broker state, runtime clock을 알지 않고 `OrderIntent + OrderbookEvent`만으로 즉시 체결 가능성을
 * 계산한다. 후속 PaperBroker PR은 이 결과를 주문 상태와 persistence event로 변환하고, backtest bridge는 같은 계산을
 * historical orderbook fixture에 재사용할 수 있다.
 */
export function simulatePaperFill(input: PaperFillSimulationInput): PaperFillSimulationResult {
  const { intent } = input;
  const requestedQuantity = normalizeDecimalString(intent.requestedQuantity);
  const orderbook = selectExecutionOrderbook(input.orderbooks, input.options);

  if (intent.orderType === "MARKET") {
    // MVP 기본 경계에서는 시장가 체결 시뮬레이션도 명시적으로 닫아 live와 paper 정책이 갈라지지 않게 한다.
    return createNoFillResult("REJECTED", "REJECTED", "market_order_simulation_disabled", requestedQuantity, {
      order_type: intent.orderType,
    });
  }

  if (orderbook === undefined) {
    // 지연 시간 이후 사용할 snapshot이 없으면 임의 체결을 만들지 않고 open 상태로 남긴다.
    return createNoFillResult("UNFILLED", "ACCEPTED", "latency_snapshot_missing", requestedQuantity);
  }

  if (orderbook.asks.length === 0 && orderbook.bids.length === 0) {
    // 비어 있는 호가 snapshot은 체결 근거가 아니므로 주문은 pending/open으로 유지한다.
    return createNoFillResult("UNFILLED", "ACCEPTED", "orderbook_snapshot_missing", requestedQuantity, {
      orderbook_received_at: orderbook.receivedAt,
    });
  }

  const timeInForce = intent.timeInForce ?? input.options?.defaultTimeInForce ?? "GTC";
  const requestedPrice = normalizeDecimalString(intent.requestedPrice);
  const wouldTakeLiquidity = isLimitOrderImmediatelyExecutable(intent, orderbook);
  const postOnly = intent.postOnly === true || timeInForce === "POST_ONLY";

  if (postOnly && wouldTakeLiquidity) {
    return simulatePostOnlyTakerRisk(input, requestedQuantity, orderbook);
  }

  const depthResult = calculateExecutableDepth(intent, orderbook, input.options);
  const openQuantity = subtractDecimalStrings(requestedQuantity, depthResult.filledQuantity);
  const hasFill = isPositiveDecimalString(depthResult.filledQuantity);
  const fullFill = isZeroDecimalString(openQuantity);

  if (timeInForce === "FOK" && !fullFill) {
    // FOK는 전체 수량을 즉시 체결할 수 없으면 부분체결도 만들지 않고 전체 수량을 취소한다.
    return createNoFillResult("FOK_CANCELED", "CANCELED", "fok_not_filled", requestedQuantity, {
      orderbook_received_at: orderbook.receivedAt,
    });
  }

  if (timeInForce === "IOC" && !fullFill) {
    // IOC는 가능한 수량만 즉시 체결하고 남은 수량은 open으로 남기지 않는다.
    return createFillResult("IOC_CANCELED", "CANCELED", "ioc_filled_and_canceled", requestedQuantity, {
      ...depthResult,
      openQuantity: "0",
      canceledQuantity: openQuantity,
      orderbookReceivedAt: orderbook.receivedAt,
      metadata: {
        requested_price: requestedPrice,
      },
    });
  }

  if (!hasFill) {
    return createNoFillResult("UNFILLED", "ACCEPTED", "limit_not_crossed", requestedQuantity, {
      orderbook_received_at: orderbook.receivedAt,
      requested_price: requestedPrice,
    });
  }

  if (fullFill) {
    return createFillResult("FILLED", "FILLED", "limit_crossed_full", requestedQuantity, {
      ...depthResult,
      openQuantity: "0",
      canceledQuantity: "0",
      orderbookReceivedAt: orderbook.receivedAt,
      metadata: {
        requested_price: requestedPrice,
      },
    });
  }

  return createFillResult("PARTIALLY_FILLED", "PARTIALLY_FILLED", "limit_crossed_partial", requestedQuantity, {
    ...depthResult,
    openQuantity,
    canceledQuantity: "0",
    orderbookReceivedAt: orderbook.receivedAt,
    metadata: {
      requested_price: requestedPrice,
    },
  });
}

function simulatePostOnlyTakerRisk(
  input: PaperFillSimulationInput,
  requestedQuantity: NumericString,
  orderbook: OrderbookEvent,
): PaperFillSimulationResult {
  const policy = input.options?.postOnlyTakerPolicy ?? "REJECT";
  if (policy === "PENDING") {
    // maker 보호 정책이 대기 모드이면 즉시 체결 가능한 snapshot에서도 fill 없이 open 상태로 유지한다.
    return createNoFillResult("POST_ONLY_PENDING", "ACCEPTED", "post_only_would_take_pending", requestedQuantity, {
      orderbook_received_at: orderbook.receivedAt,
    });
  }

  // maker-only 주문이 taker로 체결될 조건이면 broker side effect 전에 paper 주문 자체를 거부한다.
  return createNoFillResult("POST_ONLY_REJECTED", "REJECTED", "post_only_would_take_rejected", requestedQuantity, {
    orderbook_received_at: orderbook.receivedAt,
  });
}

function selectExecutionOrderbook(
  orderbooks: OrderbookEvent | readonly OrderbookEvent[],
  options: PaperFillSimulatorOptions = {},
): OrderbookEvent | undefined {
  const snapshots = Array.isArray(orderbooks) ? orderbooks : [orderbooks];
  if (snapshots.length === 0) {
    return undefined;
  }

  const latencyMs = options.latencyMs ?? 0;
  if (latencyMs <= 0 || options.submittedAt === undefined) {
    return snapshots[0];
  }

  const executionTimestamp = readTimestampMillis(options.submittedAt) + latencyMs;

  return snapshots.find((snapshot) => readTimestampMillis(snapshot.receivedAt) >= executionTimestamp);
}

function isLimitOrderImmediatelyExecutable(
  intent: Extract<OrderIntent, { orderType: "LIMIT" }>,
  orderbook: OrderbookEvent,
): boolean {
  const limitPrice = parseFinancialDecimal(intent.requestedPrice);
  if (intent.side === "BUY") {
    const bestAsk = sortAsks(orderbook.asks)[0];
    return bestAsk !== undefined && parseFinancialDecimal(bestAsk.price).lessThanOrEqualTo(limitPrice);
  }

  const bestBid = sortBids(orderbook.bids)[0];
  return bestBid !== undefined && parseFinancialDecimal(bestBid.price).greaterThanOrEqualTo(limitPrice);
}

function calculateExecutableDepth(
  intent: Extract<OrderIntent, { orderType: "LIMIT" }>,
  orderbook: OrderbookEvent,
  options: PaperFillSimulatorOptions = {},
): ExecutableDepthResult {
  const limitPrice = parseFinancialDecimal(intent.requestedPrice);
  const requestedPrice = parseFinancialDecimal(intent.requestedPrice);
  const levels = intent.side === "BUY" ? sortAsks(orderbook.asks) : sortBids(orderbook.bids);
  const takerFeeBps = parseFinancialDecimal(options.takerFeeBps ?? "0");
  let remainingQuantity = parseFinancialDecimal(intent.requestedQuantity);
  let filledQuantity = parseFinancialDecimal("0");
  let totalFillNotional = parseFinancialDecimal("0");
  let totalFee = parseFinancialDecimal("0");
  const fills: PaperFill[] = [];

  for (const level of levels) {
    const levelPrice = parseFinancialDecimal(level.price);
    const executable =
      intent.side === "BUY"
        ? levelPrice.lessThanOrEqualTo(limitPrice)
        : levelPrice.greaterThanOrEqualTo(limitPrice);

    if (!executable || remainingQuantity.lessThanOrEqualTo(0)) {
      break;
    }

    const fillQuantity = DecimalMin(remainingQuantity, parseFinancialDecimal(level.size));
    const notional = fillQuantity.mul(levelPrice);
    const fee = notional.mul(takerFeeBps).div(10000);

    filledQuantity = filledQuantity.add(fillQuantity);
    totalFillNotional = totalFillNotional.add(notional);
    totalFee = totalFee.add(fee);
    remainingQuantity = remainingQuantity.sub(fillQuantity);

    fills.push({
      price: levelPrice.toFixed(),
      quantity: fillQuantity.toFixed(),
      notional: notional.toFixed(),
      fee: fee.toFixed(),
      liquidity: "TAKER",
    });
  }

  const averageFillPrice =
    filledQuantity.greaterThan(0) ? totalFillNotional.div(filledQuantity).toFixed() : undefined;
  const slippageBps =
    averageFillPrice === undefined
      ? undefined
      : calculateSignedSlippageBps(intent.side, requestedPrice, parseFinancialDecimal(averageFillPrice));

  const result: ExecutableDepthResult = {
    fills,
    filledQuantity: filledQuantity.toFixed(),
    totalFillNotional: totalFillNotional.toFixed(),
    totalFee: totalFee.toFixed(),
  };
  if (averageFillPrice !== undefined) {
    result.averageFillPrice = averageFillPrice;
  }
  if (slippageBps !== undefined) {
    result.slippageBps = slippageBps;
  }

  return result;
}

function createFillResult(
  status: PaperFillSimulationStatus,
  orderStatus: OrderLifecycleStatus,
  reasonCode: PaperFillSimulationReasonCode,
  requestedQuantity: NumericString,
  input: ExecutableDepthResult & {
    openQuantity: NumericString;
    canceledQuantity: NumericString;
    orderbookReceivedAt: TimestampInput;
    metadata?: JsonRecord;
  },
): PaperFillSimulationResult {
  const result: PaperFillSimulationResult = {
    status,
    orderStatus,
    reasonCode,
    requestedQuantity,
    filledQuantity: input.filledQuantity,
    openQuantity: input.openQuantity,
    canceledQuantity: input.canceledQuantity,
    totalFillNotional: input.totalFillNotional,
    totalFee: input.totalFee,
    fills: input.fills,
    orderbookReceivedAt: input.orderbookReceivedAt,
  };
  if (input.averageFillPrice !== undefined) {
    result.averageFillPrice = input.averageFillPrice;
  }
  if (input.slippageBps !== undefined) {
    result.slippageBps = input.slippageBps;
  }
  if (input.metadata !== undefined) {
    result.metadata = input.metadata;
  }

  return result;
}

function createNoFillResult(
  status: PaperFillSimulationStatus,
  orderStatus: OrderLifecycleStatus,
  reasonCode: PaperFillSimulationReasonCode,
  requestedQuantity: NumericString,
  metadata?: JsonRecord,
): PaperFillSimulationResult {
  const closesOrder = orderStatus === "CANCELED" || orderStatus === "REJECTED";

  const result: PaperFillSimulationResult = {
    status,
    orderStatus,
    reasonCode,
    requestedQuantity,
    filledQuantity: "0",
    openQuantity: closesOrder ? "0" : requestedQuantity,
    canceledQuantity: closesOrder ? requestedQuantity : "0",
    fills: [],
  };
  if (metadata !== undefined) {
    result.metadata = metadata;
  }

  return result;
}

function sortAsks(levels: readonly OrderbookLevel[]): readonly OrderbookLevel[] {
  return [...levels].sort((left, right) => parseFinancialDecimal(left.price).cmp(parseFinancialDecimal(right.price)));
}

function sortBids(levels: readonly OrderbookLevel[]): readonly OrderbookLevel[] {
  return [...levels].sort((left, right) => parseFinancialDecimal(right.price).cmp(parseFinancialDecimal(left.price)));
}

function calculateSignedSlippageBps(
  side: OrderIntent["side"],
  requestedPrice: ReturnType<typeof parseFinancialDecimal>,
  averageFillPrice: ReturnType<typeof parseFinancialDecimal>,
): NumericString {
  const priceDiff =
    side === "BUY" ? averageFillPrice.sub(requestedPrice) : requestedPrice.sub(averageFillPrice);

  return priceDiff.div(requestedPrice).mul(10000).toFixed();
}

function subtractDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).sub(parseFinancialDecimal(right)).toFixed();
}

function normalizeDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).toFixed();
}

function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}

function isZeroDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).equals(0);
}

function readTimestampMillis(value: TimestampInput): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function DecimalMin(
  left: ReturnType<typeof parseFinancialDecimal>,
  right: ReturnType<typeof parseFinancialDecimal>,
): ReturnType<typeof parseFinancialDecimal> {
  return left.lessThanOrEqualTo(right) ? left : right;
}
