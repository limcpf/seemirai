import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  NumericString,
  OrderIntent,
  OrderSide,
  Strategy,
  StrategyContext,
  StrategyDecision,
  TimeInForce,
} from "../../domain/index.js";
import type {
  PaperDecisionInputFrame,
  PaperDecisionInputReplayRequest,
  PaperDecisionInputSource,
} from "./types.js";

/**
 * 메모리에 이미 올라온 decision frame 목록을 deterministic input source로 제공한다.
 *
 * 이 source는 fixture smoke와 단위 테스트용이며 DB나 네트워크를 호출하지 않는다. DB 기반 source가 추가되더라도
 * runner는 같은 `PaperDecisionInputSource` port만 소비하므로 실행 순서와 summary shape가 유지된다.
 */
export class StaticPaperDecisionInputSource implements PaperDecisionInputSource {
  private readonly frames: readonly PaperDecisionInputFrame[];

  public constructor(frames: readonly PaperDecisionInputFrame[]) {
    this.frames = frames.map(cloneFrame);
  }

  public async *replay(request: PaperDecisionInputReplayRequest = {}): AsyncIterable<PaperDecisionInputFrame> {
    const markets = request.markets === undefined ? undefined : new Set(request.markets);
    let yieldedCount = 0;

    for (const frame of this.frames) {
      if (request.sourceId !== undefined && frame.metadata?.source_id !== request.sourceId) {
        continue;
      }
      if (markets !== undefined && !markets.has(frame.market)) {
        continue;
      }

      yield cloneFrame(frame);
      yieldedCount += 1;

      if (request.limit !== undefined && yieldedCount >= request.limit) {
        return;
      }
    }
  }
}

/**
 * M9 fixture smoke가 feature -> strategy evaluation -> order intent 경계를 검증할 때 쓰는 deterministic 전략이다.
 *
 * 이 전략은 실제 alpha 품질을 주장하지 않고, fixture feature의 `paper_decision_signal`만 읽어 HOLD/BLOCK/ORDER
 * 경로를 안정적으로 만든다. 주문은 항상 지정가이며, market order를 생성하지 않아 MVP paper 안전 invariant를
 * 유지한다.
 */
export function createM9ControlledFixtureStrategy(strategyId = "m9_fixture_boundary_strategy"): Strategy {
  return {
    id: strategyId,
    version: "0.1.0",
    requiredFeatures: [
      "paper_decision_signal",
      "limit_price",
      "requested_quantity",
      "requested_notional",
    ],
    evaluate: (context) => evaluateControlledFixtureStrategy(context, strategyId),
  };
}

function evaluateControlledFixtureStrategy(
  context: StrategyContext,
  strategyId: string,
): StrategyDecision {
  const signal = readStringFeature(context, "paper_decision_signal") ?? "HOLD";

  if (signal === "HOLD") {
    return {
      kind: "HOLD",
      strategyId,
      reason: readStringFeature(context, "hold_reason") ?? "fixture_signal_absent",
      metadata: createFixtureDecisionMetadata(context),
    };
  }

  if (signal === "BLOCK") {
    const reasonCode = readStringFeature(context, "block_reason_code") ?? "fixture_strategy_blocked";
    return {
      kind: "BLOCK",
      strategyId,
      reason: readStringFeature(context, "block_reason") ?? reasonCode,
      reasonCode,
      metadata: createFixtureDecisionMetadata(context),
    };
  }

  if (signal !== "ORDER") {
    return {
      kind: "BLOCK",
      strategyId,
      reason: "Unsupported fixture paper decision signal",
      reasonCode: "fixture_signal_unsupported",
      metadata: {
        ...createFixtureDecisionMetadata(context),
        signal,
      },
    };
  }

  const orderIntent = createFixtureOrderIntent(context, strategyId);
  if (orderIntent.kind === "error") {
    return {
      kind: "BLOCK",
      strategyId,
      reason: orderIntent.message,
      reasonCode: orderIntent.reasonCode,
      metadata: createFixtureDecisionMetadata(context),
    };
  }

  return {
    kind: "ORDER_INTENT",
    strategyId,
    reason: readStringFeature(context, "order_reason") ?? "fixture_order_signal",
    orderIntents: [orderIntent.intent],
    metadata: {
      ...createFixtureDecisionMetadata(context),
      intent_count: 1,
    },
  };
}

function createFixtureOrderIntent(
  context: StrategyContext,
  strategyId: string,
):
  | {
      kind: "ok";
      intent: OrderIntent;
    }
  | {
      kind: "error";
      reasonCode: string;
      message: string;
    } {
  const exchangeId = context.exchangeId ?? readStringFeature(context, "exchange_id");
  const market = context.market ?? readStringFeature(context, "market");
  const side = readStringFeature(context, "side") ?? "BUY";
  const price = readStringFeature(context, "limit_price");
  const quantity = readStringFeature(context, "requested_quantity");
  const notional = readStringFeature(context, "requested_notional");

  if (exchangeId === undefined || exchangeId.length === 0) {
    return error("fixture_exchange_id_missing", "Fixture order requires an exchange id");
  }
  if (market === undefined || market.length === 0) {
    return error("fixture_market_missing", "Fixture order requires a market");
  }
  if (side !== "BUY" && side !== "SELL") {
    return error("fixture_side_invalid", "Fixture order side must be BUY or SELL");
  }
  if (price === undefined || quantity === undefined || notional === undefined) {
    return error("fixture_order_amount_missing", "Fixture order requires price, quantity, and notional");
  }

  const intent: OrderIntent = {
    exchangeId: exchangeId as ExchangeId,
    market: market as MarketCode,
    strategyId,
    side: side as OrderSide,
    orderType: "LIMIT",
    requestedPrice: price as NumericString,
    requestedQuantity: quantity as NumericString,
    requestedNotional: notional as NumericString,
    idempotencyKey: readStringFeature(context, "idempotency_key") ?? createFixtureIdempotencyKey(context, strategyId),
    reason: readStringFeature(context, "order_reason") ?? "fixture_order_signal",
    timeInForce: readFixtureTimeInForce(context),
    metadata: {
      ...createFixtureDecisionMetadata(context),
      fixture_controlled_strategy: true,
    },
  };

  const postOnly = readBooleanFeature(context, "post_only");
  if (postOnly !== undefined) {
    // fixture smoke는 controlled fill 경로를 열기 위해 post-only 선호를 명시적으로 끌 수 있다.
    intent.postOnly = postOnly;
  }

  return {
    kind: "ok",
    intent,
  };
}

function createFixtureDecisionMetadata(context: StrategyContext): JsonRecord {
  return {
    source: "m9_paper_decision_fixture",
    frame_id: readStringMetadata(context.metadata, "frame_id") ?? "unknown",
  };
}

function createFixtureIdempotencyKey(context: StrategyContext, strategyId: string): string {
  const exchangeId = context.exchangeId ?? readStringFeature(context, "exchange_id") ?? "unknown_exchange";
  const market = context.market ?? readStringFeature(context, "market") ?? "unknown_market";
  const frameId = readStringMetadata(context.metadata, "frame_id") ?? String(context.observedAt);

  return `${strategyId}:${exchangeId}:${market}:${frameId}`;
}

function readFixtureTimeInForce(context: StrategyContext): TimeInForce {
  const value = readStringFeature(context, "time_in_force");
  if (value === "GTC" || value === "IOC" || value === "FOK" || value === "POST_ONLY") {
    return value;
  }

  return "GTC";
}

function readStringFeature(context: StrategyContext, key: string): string | undefined {
  const value = context.features[key];

  return typeof value === "string" ? value : undefined;
}

function readBooleanFeature(context: StrategyContext, key: string): boolean | undefined {
  const value = context.features[key];

  return typeof value === "boolean" ? value : undefined;
}

function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" ? value : undefined;
}

function error(reasonCode: string, message: string): {
  kind: "error";
  reasonCode: string;
  message: string;
} {
  return {
    kind: "error",
    reasonCode,
    message,
  };
}

function cloneFrame(frame: PaperDecisionInputFrame): PaperDecisionInputFrame {
  return structuredClone(frame) as PaperDecisionInputFrame;
}
