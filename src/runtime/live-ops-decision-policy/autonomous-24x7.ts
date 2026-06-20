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

export const LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID = "live_ops_autonomous_24x7_core";

const minimumUpbitKrwOrderNotional = new Decimal(5_000);
const bpsDenominator = new Decimal(10_000);

/**
 * 24/7 live ops entry/exit 전략의 non-secret parameter contract다.
 *
 * 책임:
 * - config JSON에서 검증된 수치만 받아 broker side effect 없는 전략 판단에 사용한다.
 * - 유명 투자자의 공통 원칙을 코드화할 수 있는 보수적 primitive로 나눈다: 추세 확인, 평균회귀 가격 여유, 손실 제한, 이익 보호,
 *   시간 기반 회수, 과도한 노출 축소.
 *
 * invariant:
 * - entry 주문은 `BUY + LIMIT + POST_ONLY`, exit 주문은 `SELL + LIMIT + POST_ONLY`만 생성한다.
 * - 전략은 broker, Upbit client, DB, Telegram port를 알지 못한다.
 */
export interface LiveOpsAutonomous24x7StrategyOptions {
  readonly maxEntryNotionalKrw: NumericString;
  readonly tickSizeKrw: NumericString;
  readonly entryPriceOffsetTicks: number;
  readonly exitPriceOffsetTicks: number;
  readonly quantityScale: number;
  readonly minEntryMarginBps: NumericString;
  readonly trendConfirmationBps: NumericString;
  readonly meanReversionDiscountBps: NumericString;
  readonly takeProfitBps: NumericString;
  readonly stopLossBps: NumericString;
  readonly trailingStopBps: NumericString;
  readonly maxHoldingMs: number;
  readonly riskReductionOpenNotionalKrw: NumericString;
  readonly riskReductionSellFraction: NumericString;
  readonly expectedLossBpsOfEquity: NumericString;
}

/**
 * Issue #206의 24/7 자동 매수/보유/매도 core strategy를 만든다.
 *
 * @param options production config에서 온 non-secret strategy parameter
 * @returns entry/exit `OrderIntent` 또는 HOLD/BLOCK decision만 반환하는 strategy 구현체
 *
 * invariant:
 * - 보유 포지션 수량이 0보다 크면 entry 조건이 강해도 exit policy만 평가하고 BUY 후보를 만들지 않는다.
 * - exit 후보는 보유 수량 이하의 SELL LIMIT POST_ONLY만 생성한다.
 */
export function createLiveOpsAutonomous24x7Strategy(options: LiveOpsAutonomous24x7StrategyOptions): Strategy {
  const normalizedOptions = normalizeOptions(options);

  return {
    id: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    version: "1",
    requiredFeatures: [],
    evaluate: (context) => evaluateAutonomous24x7(context, normalizedOptions),
  };
}

/**
 * 24/7 strategy의 최상위 entry/exit 분기다.
 *
 * 책임:
 * - market/orderbook/position snapshot을 확인한 뒤 보유 중이면 exit policy, 미보유면 entry policy로 보낸다.
 * - scope mismatch나 snapshot invalid는 주문 후보 없음이 아니라 BLOCK으로 닫는다.
 *
 * side effect:
 * - 없음. 이 함수는 StrategyDecision 값만 반환한다.
 */
function evaluateAutonomous24x7(
  context: StrategyContext,
  options: NormalizedOptions,
): StrategyDecision {
  if (context.exchangeId !== "upbit_krw_spot" || context.market !== "KRW-BTC") {
    // 첫 24/7 운영은 BTC/KRW 단일 universe만 예산을 공유하므로 다른 scope는 strategy 단계에서 닫는다.
    return block("autonomous_24x7_scope_mismatch", {
      exchange_id: context.exchangeId,
      market: context.market,
    });
  }

  const orderbook = selectLatestOrderbook(context.marketEvents, context.market);
  if (orderbook === undefined) {
    // post-only 가격은 최신 호가 없이는 재현할 수 없으므로 후보 없이 다음 market data tick을 기다린다.
    return hold("autonomous_24x7_orderbook_missing", { market: context.market });
  }

  const positionResult = readPositionSnapshot(context.positions);
  if (positionResult.kind === "blocked") {
    return block(positionResult.reasonCode, positionResult.metadata);
  }

  const position = positionResult.snapshot;
  if (position.quantity.gt(0)) {
    // 보유 중에는 물타기식 신규 진입보다 청산/축소 판단이 우선이라 entry evaluation으로 내려가지 않는다.
    return evaluateExitPolicy({
      context,
      orderbook,
      options,
      position,
    });
  }

  return evaluateEntryPolicy({ context, orderbook, options });
}

/**
 * 보유 포지션의 SELL 후보 또는 HOLD/BLOCK을 평가한다.
 *
 * invariant:
 * - 생성되는 SELL intent는 보유 수량 이하의 LIMIT POST_ONLY 후보여야 한다.
 * - exit 조건이 없으면 entry 평가로 넘어가지 않고 HOLD로 닫는다.
 */
function evaluateExitPolicy(input: {
  readonly context: StrategyContext;
  readonly orderbook: OrderbookEvent;
  readonly options: NormalizedOptions;
  readonly position: PositionSnapshot;
}): StrategyDecision {
  const bestBid = readBestBid(input.orderbook);
  const bestAsk = readBestAsk(input.orderbook);
  if (bestBid === undefined || bestAsk === undefined) {
    return hold("autonomous_24x7_exit_orderbook_incomplete", {
      bid_level_count: input.orderbook.bids.length,
      ask_level_count: input.orderbook.asks.length,
    });
  }

  const exitRule = selectExitRule({
    observedAt: String(input.context.observedAt),
    bestBid,
    options: input.options,
    position: input.position,
  });
  if (exitRule === undefined) {
    return hold("autonomous_24x7_position_hold", {
      source: "live_ops_autonomous_24x7",
      quantity: input.position.quantity.toFixed(),
      average_entry_price: input.position.averageEntryPrice.toFixed(),
    });
  }

  const requestedPrice = bestAsk.plus(input.options.tickSizeKrw.mul(input.options.exitPriceOffsetTicks));
  const targetSellQuantity = calculateExitQuantity(input.position.quantity, input.options, exitRule.kind);
  const sellQuantity = capExitQuantityByOrderNotional({
    targetQuantity: targetSellQuantity,
    requestedPrice,
    maxNotionalKrw: input.options.maxEntryNotionalKrw,
    quantityScale: input.options.quantityScale,
  });
  const sizing = createLimitSizing({
    side: "SELL",
    requestedPrice,
    requestedQuantity: sellQuantity,
    minimumNotionalKrw: minimumUpbitKrwOrderNotional,
    maxNotionalKrw: input.options.maxEntryNotionalKrw,
  });
  if (sizing.kind === "blocked") {
    return block(sizing.reasonCode, sizing.metadata);
  }

  const intent = createLimitIntent({
    side: "SELL",
    reason: exitRule.reason,
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    observedAt: String(input.context.observedAt),
    metadata: {
      ...exitRule.metadata,
      source: "live_ops_autonomous_24x7",
      policy_id: "autonomous_24x7",
      expected_loss_bps_of_equity: input.options.expectedLossBpsOfEquity.toFixed(),
      position_effect: sellQuantity.eq(input.position.quantity) ? "EXIT" : "REDUCE",
      exit_reason_code: exitRule.reason,
      exit_rule_id: exitRule.kind,
      exit_cost_bps: "0",
      exit_slippage_bps: "0",
      position_scope: {
        market: "KRW-BTC",
        strategy_id: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
        total_quantity: input.position.quantity.toFixed(),
      },
      exit_target_quantity: targetSellQuantity.toFixed(),
      exit_chunked: sellQuantity.lt(targetSellQuantity) ? "true" : "false",
      max_exit_notional_krw: input.options.maxEntryNotionalKrw.toFixed(),
      best_bid_price: bestBid.toFixed(),
      best_ask_price: bestAsk.toFixed(),
      held_quantity: input.position.quantity.toFixed(),
      average_entry_price: input.position.averageEntryPrice.toFixed(),
    },
  });

  return {
    kind: "ORDER_INTENT",
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    reason: exitRule.reason,
    orderIntents: [intent],
    metadata: {
      source: "live_ops_autonomous_24x7",
      phase: "exit",
      rule: exitRule.kind,
      intent_count: 1,
    },
  };
}

/**
 * 미보유 상태의 BUY 후보 또는 HOLD/BLOCK을 평가한다.
 *
 * invariant:
 * - 생성되는 BUY intent는 production 단일 주문 예산 이하의 LIMIT POST_ONLY 후보여야 한다.
 * - signal이 약하면 broker 호출 경계로 넘어갈 수 있는 후보를 만들지 않는다.
 */
function evaluateEntryPolicy(input: {
  readonly context: StrategyContext;
  readonly orderbook: OrderbookEvent;
  readonly options: NormalizedOptions;
}): StrategyDecision {
  const bestBid = readBestBid(input.orderbook);
  if (bestBid === undefined) {
    return hold("autonomous_24x7_entry_best_bid_missing", {
      bid_level_count: input.orderbook.bids.length,
    });
  }

  const signal = evaluateEntrySignal(input.context.features, input.options);
  if (!signal.ready) {
    // 유명 투자자식 "기다릴 줄 아는 현금 보유" 원칙을 실주문 후보 없음으로 표현한다.
    return hold("autonomous_24x7_entry_signal_weak", signal.metadata);
  }

  const requestedPrice = bestBid.minus(input.options.tickSizeKrw.mul(input.options.entryPriceOffsetTicks));
  const requestedQuantity = input.options.maxEntryNotionalKrw
    .div(requestedPrice)
    .toDecimalPlaces(input.options.quantityScale, Decimal.ROUND_DOWN);
  const sizing = createLimitSizing({
    side: "BUY",
    requestedPrice,
    requestedQuantity,
    minimumNotionalKrw: minimumUpbitKrwOrderNotional,
    maxNotionalKrw: input.options.maxEntryNotionalKrw,
  });
  if (sizing.kind === "blocked") {
    return block(sizing.reasonCode, sizing.metadata);
  }

  const intent = createLimitIntent({
    side: "BUY",
    reason: "autonomous_24x7_entry_signal",
    requestedPrice: sizing.requestedPrice,
    requestedQuantity: sizing.requestedQuantity,
    requestedNotional: sizing.requestedNotional,
    observedAt: String(input.context.observedAt),
    metadata: {
      source: "live_ops_autonomous_24x7",
      policy_id: "autonomous_24x7",
      expected_loss_bps_of_equity: input.options.expectedLossBpsOfEquity.toFixed(),
      best_bid_price: bestBid.toFixed(),
      ...signal.metadata,
    },
  });

  return {
    kind: "ORDER_INTENT",
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    reason: "autonomous_24x7_entry_signal",
    orderIntents: [intent],
    metadata: {
      source: "live_ops_autonomous_24x7",
      phase: "entry",
      intent_count: 1,
    },
  };
}

/**
 * 24/7 strategy가 계산에 사용하는 정규화된 parameter 묶음이다.
 *
 * 책임:
 * - JSON string threshold를 Decimal로 변환해 금융 수치 계산의 정밀도 손실을 줄인다.
 * - entry/exit sizing과 rule threshold가 같은 단위(bps, KRW, fraction)를 유지하게 한다.
 */
interface NormalizedOptions {
  readonly maxEntryNotionalKrw: Decimal;
  readonly tickSizeKrw: Decimal;
  readonly entryPriceOffsetTicks: number;
  readonly exitPriceOffsetTicks: number;
  readonly quantityScale: number;
  readonly minEntryMarginBps: Decimal;
  readonly trendConfirmationBps: Decimal;
  readonly meanReversionDiscountBps: Decimal;
  readonly takeProfitBps: Decimal;
  readonly stopLossBps: Decimal;
  readonly trailingStopBps: Decimal;
  readonly maxHoldingMs: number;
  readonly riskReductionOpenNotionalKrw: Decimal;
  readonly riskReductionSellFraction: Decimal;
  readonly expectedLossBpsOfEquity: Decimal;
}

/**
 * config schema를 통과한 24/7 strategy parameter를 Decimal 기반 내부 표현으로 정규화한다.
 *
 * @param options JSON config에서 읽은 non-secret threshold
 * @returns 계산 중 정밀도 손실을 피하는 Decimal/number 조합
 *
 * side effect:
 * - 없음. 입력 검증 실패 시 broker/DB 상태를 바꾸지 않고 예외만 던진다.
 */
function normalizeOptions(options: LiveOpsAutonomous24x7StrategyOptions): NormalizedOptions {
  return {
    maxEntryNotionalKrw: readPositiveDecimal(options.maxEntryNotionalKrw, "maxEntryNotionalKrw"),
    tickSizeKrw: readPositiveDecimal(options.tickSizeKrw, "tickSizeKrw"),
    entryPriceOffsetTicks: readPositiveInteger(options.entryPriceOffsetTicks, "entryPriceOffsetTicks"),
    exitPriceOffsetTicks: readPositiveInteger(options.exitPriceOffsetTicks, "exitPriceOffsetTicks"),
    quantityScale: readPositiveInteger(options.quantityScale, "quantityScale"),
    minEntryMarginBps: readPositiveDecimal(options.minEntryMarginBps, "minEntryMarginBps"),
    trendConfirmationBps: readPositiveDecimal(options.trendConfirmationBps, "trendConfirmationBps"),
    meanReversionDiscountBps: readPositiveDecimal(options.meanReversionDiscountBps, "meanReversionDiscountBps"),
    takeProfitBps: readPositiveDecimal(options.takeProfitBps, "takeProfitBps"),
    stopLossBps: readPositiveDecimal(options.stopLossBps, "stopLossBps"),
    trailingStopBps: readPositiveDecimal(options.trailingStopBps, "trailingStopBps"),
    maxHoldingMs: readPositiveInteger(options.maxHoldingMs, "maxHoldingMs"),
    riskReductionOpenNotionalKrw: readPositiveDecimal(
      options.riskReductionOpenNotionalKrw,
      "riskReductionOpenNotionalKrw",
    ),
    riskReductionSellFraction: readPositiveFractionDecimal(
      options.riskReductionSellFraction,
      "riskReductionSellFraction",
    ),
    expectedLossBpsOfEquity: readNonNegativeDecimal(options.expectedLossBpsOfEquity, "expectedLossBpsOfEquity"),
  };
}

/**
 * strategy 평가 시점의 보유 포지션 snapshot이다.
 *
 * 책임:
 * - exit rule과 SELL sizing에 필요한 최소 값만 보존한다.
 * - raw provider payload나 credential, DB connection 같은 외부 의존성을 strategy에서 차단한다.
 */
interface PositionSnapshot {
  readonly quantity: Decimal;
  readonly averageEntryPrice: Decimal;
  readonly openedAt: string | undefined;
  readonly highWatermarkPrice: Decimal | undefined;
  readonly openPositionNotionalKrw: Decimal | undefined;
}

/**
 * 24/7 strategy가 읽는 현재 포지션의 최소 safe snapshot이다.
 *
 * 책임:
 * - DB row나 provider payload 전체를 strategy로 넘기지 않고 수량, 평균단가, 보유 시간, high-watermark, 노출 금액만 표현한다.
 * - exit sizing이 보유 수량을 초과하지 않게 하는 기준값을 제공한다.
 *
 * side effect:
 * - 없음. 이 타입은 값 객체이며 조회나 저장을 수행하지 않는다.
 */
type PositionSnapshotReadResult = {
  readonly kind: "ok";
  readonly snapshot: PositionSnapshot;
} | {
  readonly kind: "blocked";
  readonly reasonCode: string;
  readonly metadata: JsonRecord;
};

/**
 * strategy context의 `positions` 값을 24/7 policy가 사용할 수 있는 snapshot으로 낮춘다.
 *
 * @param input analysis pipeline이 전달한 secret-safe position snapshot
 * @returns 정상 snapshot 또는 broker 호출 전 차단해야 하는 invalid snapshot 결과
 */
function readPositionSnapshot(input: JsonRecord | undefined): PositionSnapshotReadResult {
  if (input === undefined) {
    return {
      kind: "ok",
      snapshot: {
        quantity: new Decimal(0),
        averageEntryPrice: new Decimal(0),
        openedAt: undefined,
        highWatermarkPrice: undefined,
        openPositionNotionalKrw: undefined,
      },
    };
  }

  const quantity = readOptionalDecimal(input.quantity);
  const averageEntryPrice = readOptionalDecimal(input.averageEntryPrice);
  if (quantity === undefined || averageEntryPrice === undefined) {
    return {
      kind: "blocked",
      reasonCode: "autonomous_24x7_position_snapshot_invalid",
      metadata: { has_quantity: quantity !== undefined, has_average_entry_price: averageEntryPrice !== undefined },
    };
  }

  return {
    kind: "ok",
    snapshot: {
      quantity,
      averageEntryPrice,
      openedAt: typeof input.openedAt === "string" ? input.openedAt : undefined,
      highWatermarkPrice: readOptionalDecimal(input.highWatermarkPrice),
      openPositionNotionalKrw: readOptionalDecimal(input.openPositionNotionalKrw),
    },
  };
}

/**
 * exit policy가 선택한 단일 rule과 사용자-facing reason이다.
 *
 * 책임:
 * - SELL intent의 reason/metadata를 안정적으로 만들고, rule별 테스트가 독립 reason code를 검증하게 한다.
 */
interface ExitRuleSelection {
  readonly kind: "stop_loss" | "max_holding_time" | "risk_reduction" | "trailing_stop" | "take_profit";
  readonly reason: string;
  readonly metadata: JsonRecord;
}

/**
 * 현재 가격과 포지션 snapshot에서 우선 적용할 exit rule 하나를 고른다.
 *
 * @param input observedAt, best bid, policy threshold, position snapshot
 * @returns 적용할 exit reason 또는 exit 조건 없음
 *
 * invariant:
 * - rule 선택은 주문 제출이 아니라 intent reason 선택까지만 수행한다.
 * - stop loss, max holding, risk reduction, trailing stop, take profit 순서로 보수적 회수 조건을 먼저 본다.
 */
function selectExitRule(input: {
  readonly observedAt: string;
  readonly bestBid: Decimal;
  readonly options: NormalizedOptions;
  readonly position: PositionSnapshot;
}): ExitRuleSelection | undefined {
  const entryPrice = input.position.averageEntryPrice;
  if (entryPrice.lte(0)) {
    return {
      kind: "risk_reduction",
      reason: "autonomous_24x7_risk_reduction",
      metadata: { reason_code: "average_entry_price_missing" },
    };
  }

  const stopLossPrice = entryPrice.mul(bpsDenominator.minus(input.options.stopLossBps)).div(bpsDenominator);
  if (input.bestBid.lte(stopLossPrice)) {
    return {
      kind: "stop_loss",
      reason: "autonomous_24x7_stop_loss",
      metadata: { stop_loss_price: stopLossPrice.toFixed() },
    };
  }

  if (isMaxHoldingTimeReached(input.observedAt, input.position.openedAt, input.options.maxHoldingMs)) {
    return {
      kind: "max_holding_time",
      reason: "autonomous_24x7_max_holding_time",
      metadata: { opened_at: input.position.openedAt ?? null, max_holding_ms: input.options.maxHoldingMs },
    };
  }

  if (
    input.position.openPositionNotionalKrw !== undefined &&
    input.position.openPositionNotionalKrw.gt(input.options.riskReductionOpenNotionalKrw)
  ) {
    return {
      kind: "risk_reduction",
      reason: "autonomous_24x7_risk_reduction",
      metadata: {
        open_position_notional_krw: input.position.openPositionNotionalKrw.toFixed(),
        threshold_krw: input.options.riskReductionOpenNotionalKrw.toFixed(),
      },
    };
  }

  if (input.position.highWatermarkPrice !== undefined && input.position.highWatermarkPrice.gt(0)) {
    const trailingStopPrice = input.position.highWatermarkPrice
      .mul(bpsDenominator.minus(input.options.trailingStopBps))
      .div(bpsDenominator);
    if (input.bestBid.lte(trailingStopPrice)) {
      return {
        kind: "trailing_stop",
        reason: "autonomous_24x7_trailing_stop",
        metadata: {
          high_watermark_price: input.position.highWatermarkPrice.toFixed(),
          trailing_stop_price: trailingStopPrice.toFixed(),
        },
      };
    }
  }

  const takeProfitPrice = entryPrice.mul(bpsDenominator.plus(input.options.takeProfitBps)).div(bpsDenominator);
  if (input.bestBid.gte(takeProfitPrice)) {
    return {
      kind: "take_profit",
      reason: "autonomous_24x7_take_profit",
      metadata: { take_profit_price: takeProfitPrice.toFixed() },
    };
  }

  return undefined;
}

/**
 * 포지션 보유 시간이 policy의 최대 보유 시간을 넘었는지 확인한다.
 *
 * side effect:
 * - 없음. ISO timestamp parsing만 수행하며 실패하면 안전하게 false로 닫는다.
 */
function isMaxHoldingTimeReached(observedAt: string, openedAt: string | undefined, maxHoldingMs: number): boolean {
  if (openedAt === undefined) {
    return false;
  }

  const observed = Date.parse(observedAt);
  const opened = Date.parse(openedAt);
  return Number.isFinite(observed) && Number.isFinite(opened) && observed - opened >= maxHoldingMs;
}

/**
 * exit rule별 매도 수량을 계산한다.
 *
 * 책임:
 * - risk reduction은 부분 축소 수량으로 낮추고, 나머지 exit rule은 보유 수량 전체를 후보로 만든다.
 * - quantity scale로 내림 처리해 보유 수량 초과 SELL 후보가 생기지 않게 한다.
 */
function calculateExitQuantity(quantity: Decimal, options: NormalizedOptions, rule: ExitRuleSelection["kind"]): Decimal {
  if (rule === "risk_reduction") {
    return quantity.mul(options.riskReductionSellFraction).toDecimalPlaces(options.quantityScale, Decimal.ROUND_DOWN);
  }

  return quantity.toDecimalPlaces(options.quantityScale, Decimal.ROUND_DOWN);
}

/**
 * exit 후보 수량을 1회 주문 한도 안의 chunk로 낮춘다.
 *
 * 책임:
 * - 누적 포지션이 최대 open position 한도까지 커졌더라도 Upbit 제출 한 번은 small-budget 단일 주문 한도를 넘지 않게 한다.
 * - 전체 청산 rule도 필요한 경우 여러 daemon tick의 `REDUCE` 주문으로 쪼갤 수 있게 한다.
 *
 * side effect:
 * - 없음. 순수 수량 계산만 수행한다.
 */
function capExitQuantityByOrderNotional(input: {
  readonly targetQuantity: Decimal;
  readonly requestedPrice: Decimal;
  readonly maxNotionalKrw: Decimal;
  readonly quantityScale: number;
}): Decimal {
  if (!input.requestedPrice.gt(0)) {
    return new Decimal(0);
  }

  const maxQuantity = input.maxNotionalKrw
    .div(input.requestedPrice)
    .toDecimalPlaces(input.quantityScale, Decimal.ROUND_DOWN);

  return Decimal.min(input.targetQuantity, maxQuantity).toDecimalPlaces(input.quantityScale, Decimal.ROUND_DOWN);
}

/**
 * entry 후보를 만들 만큼 비용 차감 margin과 trend/mean-reversion 신호가 강한지 평가한다.
 *
 * @param features feature snapshot에서 전달된 secret-free 수치
 * @param options strategy threshold
 * @returns BUY 후보 가능 여부와 decision metadata
 */
function evaluateEntrySignal(features: Readonly<Record<string, unknown>>, options: NormalizedOptions): {
  readonly ready: boolean;
  readonly metadata: JsonRecord;
} {
  const margin = readOptionalDecimal(features.cost_adjusted_margin_bps) ?? new Decimal(0);
  const trend = readOptionalDecimal(features.trend_strength_bps) ?? new Decimal(0);
  const meanReversion = readOptionalDecimal(features.mean_reversion_discount_bps) ?? new Decimal(0);
  const marginReady = margin.gte(options.minEntryMarginBps);
  const trendReady = trend.gte(options.trendConfirmationBps);
  const meanReversionReady = meanReversion.gte(options.meanReversionDiscountBps);

  return {
    ready: marginReady && (trendReady || meanReversionReady),
    metadata: {
      cost_adjusted_margin_bps: margin.toFixed(),
      trend_strength_bps: trend.toFixed(),
      mean_reversion_discount_bps: meanReversion.toFixed(),
      min_entry_margin_bps: options.minEntryMarginBps.toFixed(),
      trend_confirmation_bps: options.trendConfirmationBps.toFixed(),
      mean_reversion_discount_bps_threshold: options.meanReversionDiscountBps.toFixed(),
    },
  };
}

/**
 * LIMIT 주문 후보의 가격, 수량, 명목금액을 검증한다.
 *
 * invariant:
 * - BUY 후보는 단일 주문 예산을 초과하면 차단한다.
 * - BUY/SELL 모두 Upbit 최소 주문금액 미만이면 broker 제출 전에 차단한다.
 */
function createLimitSizing(input: {
  readonly side: "BUY" | "SELL";
  readonly requestedPrice: Decimal;
  readonly requestedQuantity: Decimal;
  readonly minimumNotionalKrw: Decimal;
  readonly maxNotionalKrw?: Decimal;
}): {
  readonly kind: "ok";
  readonly requestedPrice: NumericString;
  readonly requestedQuantity: NumericString;
  readonly requestedNotional: NumericString;
} | {
  readonly kind: "blocked";
  readonly reasonCode: string;
  readonly metadata: JsonRecord;
} {
  if (!input.requestedPrice.gt(0) || !input.requestedQuantity.gt(0)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${input.side.toLowerCase()}_sizing_invalid`,
      metadata: {
        requested_price: input.requestedPrice.toFixed(),
        requested_quantity: input.requestedQuantity.toFixed(),
      },
    };
  }

  const requestedNotional = input.requestedPrice.mul(input.requestedQuantity);
  if (requestedNotional.lt(input.minimumNotionalKrw)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${input.side.toLowerCase()}_notional_below_minimum`,
      metadata: {
        requested_notional_krw: requestedNotional.toFixed(),
        minimum_order_notional_krw: input.minimumNotionalKrw.toFixed(),
      },
    };
  }

  if (input.maxNotionalKrw !== undefined && requestedNotional.gt(input.maxNotionalKrw)) {
    return {
      kind: "blocked",
      reasonCode: `autonomous_24x7_${input.side.toLowerCase()}_notional_above_budget`,
      metadata: {
        requested_notional_krw: requestedNotional.toFixed(),
        max_notional_krw: input.maxNotionalKrw.toFixed(),
      },
    };
  }

  return {
    kind: "ok",
    requestedPrice: input.requestedPrice.toFixed() as NumericString,
    requestedQuantity: input.requestedQuantity.toFixed() as NumericString,
    requestedNotional: requestedNotional.toFixed() as NumericString,
  };
}

/**
 * strategy decision에서 반환할 BUY/SELL LIMIT POST_ONLY intent를 만든다.
 *
 * side effect:
 * - 없음. CostModel/RiskGate/broker 경계로 전달할 값 객체만 생성한다.
 */
function createLimitIntent(input: {
  readonly side: "BUY" | "SELL";
  readonly reason: string;
  readonly requestedPrice: NumericString;
  readonly requestedQuantity: NumericString;
  readonly requestedNotional: NumericString;
  readonly observedAt: string;
  readonly metadata: JsonRecord;
}): OrderIntent {
  return {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    side: input.side,
    orderType: "LIMIT",
    requestedPrice: input.requestedPrice,
    requestedQuantity: input.requestedQuantity,
    requestedNotional: input.requestedNotional,
    idempotencyKey: createIdempotencyKey(input),
    reason: input.reason,
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: input.metadata,
  };
}

/**
 * 같은 날짜와 같은 주문 후보가 같은 decision key를 갖도록 stable idempotency key를 만든다.
 *
 * invariant:
 * - key는 broker identifier가 아니라 strategy decision fingerprint이며, 실제 Upbit identifier 길이 조정은 execution adapter가 담당한다.
 */
function createIdempotencyKey(input: {
  readonly side: "BUY" | "SELL";
  readonly reason: string;
  readonly requestedPrice: NumericString;
  readonly requestedQuantity: NumericString;
  readonly requestedNotional: NumericString;
  readonly observedAt: string;
}): string {
  const dateScope = /^\d{4}-\d{2}-\d{2}/u.test(input.observedAt) ? input.observedAt.slice(0, 10) : "unknown_date";
  return [
    LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    dateScope,
    "upbit_krw_spot",
    "KRW-BTC",
    input.side,
    input.reason,
    input.requestedPrice,
    input.requestedQuantity,
    input.requestedNotional,
  ].join(":");
}

/**
 * 현재 market에 대한 최신 orderbook event를 선택한다.
 *
 * side effect:
 * - 없음. 입력 event window만 역순으로 스캔한다.
 */
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

/**
 * orderbook bids에서 가장 높은 매수 호가를 Decimal로 읽는다.
 */
function readBestBid(orderbook: OrderbookEvent): Decimal | undefined {
  const bids = orderbook.bids
    .map((level) => readOptionalDecimal(level.price))
    .filter((price): price is Decimal => price !== undefined)
    .toSorted((left, right) => right.comparedTo(left));

  return bids[0];
}

/**
 * orderbook asks에서 가장 낮은 매도 호가를 Decimal로 읽는다.
 */
function readBestAsk(orderbook: OrderbookEvent): Decimal | undefined {
  const asks = orderbook.asks
    .map((level) => readOptionalDecimal(level.price))
    .filter((price): price is Decimal => price !== undefined)
    .toSorted((left, right) => left.comparedTo(right));

  return asks[0];
}

/**
 * JSON 값에서 Decimal로 해석 가능한 숫자만 안전하게 읽는다.
 *
 * side effect:
 * - 없음. 파싱 실패는 undefined로 낮춰 상위 guard가 HOLD/BLOCK을 결정하게 한다.
 */
function readOptionalDecimal(value: unknown): Decimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 양수 Decimal parameter를 검증한다.
 */
function readPositiveDecimal(value: NumericString, fieldName: string): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || !decimal.gt(0)) {
    throw new Error(`InvalidPositiveDecimal:${fieldName}`);
  }

  return decimal;
}

/**
 * 0 이상 Decimal parameter를 검증한다.
 */
function readNonNegativeDecimal(value: NumericString, fieldName: string): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.lt(0)) {
    throw new Error(`InvalidNonNegativeDecimal:${fieldName}`);
  }

  return decimal;
}

/**
 * 0보다 크고 1 이하인 비율 parameter를 검증한다.
 */
function readPositiveFractionDecimal(value: NumericString, fieldName: string): Decimal {
  const decimal = readPositiveDecimal(value, fieldName);
  if (decimal.gt(1)) {
    throw new Error(`InvalidPositiveFractionDecimal:${fieldName}`);
  }

  return decimal;
}

/**
 * 양의 정수 parameter를 검증한다.
 */
function readPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`InvalidPositiveInteger:${fieldName}`);
  }

  return value;
}

/**
 * 주문 후보 없이 대기하는 strategy decision을 만든다.
 */
function hold(reason: string, metadata?: JsonRecord): StrategyDecision {
  return {
    kind: "HOLD",
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    reason,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * strategy 단계에서 후보 생성을 차단하는 decision을 만든다.
 */
function block(reasonCode: string, metadata?: JsonRecord): StrategyDecision {
  return {
    kind: "BLOCK",
    strategyId: LIVE_OPS_AUTONOMOUS_24X7_STRATEGY_ID,
    reason: reasonCode,
    reasonCode,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
