import { parseFinancialDecimal } from "../../../shared/index.js";
import type { Decimal } from "decimal.js";
import type { ExchangeId, MarketCode, StrategyContext, StrategyDecision } from "../../../domain/index.js";
import { block } from "./decision-factory.js";
import type { DecimalRead } from "./types.js";

/**
 * strategy feature를 필수 Decimal 값으로 읽고, 실패 시 BLOCK decision으로 닫는다.
 *
 * 누락과 invalid 값을 HOLD가 아니라 BLOCK으로 분리해 feature 생성 경계가 깨진 주문 후보를 fail-closed한다.
 */
export function requireFeatureDecimal(
  context: StrategyContext,
  key: string,
  strategyId: string,
):
  | {
      kind: "value";
      value: Decimal;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const read = readFeatureDecimal(context, key);

  if (read.status === "ok") {
    return {
      kind: "value",
      value: read.value,
    };
  }

  if (read.status === "missing") {
    return {
      kind: "decision",
      decision: block(strategyId, `feature_missing_${key}`, `${key} feature is required`, {
        feature_key: key,
        reason_family: "feature_missing",
      }),
    };
  }

  return {
    kind: "decision",
    decision: block(strategyId, `feature_invalid_${key}`, `${key} feature must be a decimal string`, {
      feature_key: key,
      reason_family: "feature_invalid",
    }),
  };
}

/**
 * feature map의 raw 값을 DecimalRead로 변환한다.
 *
 * 이 함수는 BLOCK decision을 만들지 않는 낮은 수준 reader이며, 호출자는 missing/invalid 상태를 strategy 경계에서
 * fail-closed decision으로 바꿔야 한다.
 */
export function readFeatureDecimal(context: StrategyContext, key: string): DecimalRead {
  const value = context.features[key];

  if (value === undefined || value === null) {
    return {
      status: "missing",
    };
  }

  try {
    return {
      status: "ok",
      value: parseFinancialDecimal(value),
    };
  } catch {
    return {
      status: "invalid",
    };
  }
}

/**
 * strategy context에서 exchange id를 읽고 없으면 BLOCK decision으로 닫는다.
 *
 * 주문 후보 idempotency key와 OrderIntent 생성에 필요한 routing 식별자라서 feature fallback까지 확인하되 빈 값은 허용하지 않는다.
 */
export function readExchangeId(
  context: StrategyContext,
  strategyId: string,
):
  | {
      kind: "value";
      value: ExchangeId;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const exchangeId = context.exchangeId ?? readStringFeature(context, "exchange_id");

  if (exchangeId === undefined || exchangeId.trim().length === 0) {
    return {
      kind: "decision",
      decision: block(strategyId, "exchange_id_missing", "exchange id is required"),
    };
  }

  return {
    kind: "value",
    value: exchangeId,
  };
}

/**
 * strategy context에서 market code를 읽고 없으면 BLOCK decision으로 닫는다.
 *
 * 시장 식별자는 주문 intent와 idempotency key에 함께 들어가므로 context 우선, feature fallback 순서로 읽고 빈 값은 차단한다.
 */
export function readMarket(
  context: StrategyContext,
  strategyId: string,
):
  | {
      kind: "value";
      value: MarketCode;
    }
  | {
      kind: "decision";
      decision: StrategyDecision;
    } {
  const market = context.market ?? readStringFeature(context, "market");

  if (market === undefined || market.trim().length === 0) {
    return {
      kind: "decision",
      decision: block(strategyId, "market_missing", "market is required"),
    };
  }

  return {
    kind: "value",
    value: market,
  };
}

/**
 * feature map에서 string 값만 읽는다.
 *
 * 방향/regime 같은 enum feature는 숫자와 섞이면 신뢰할 수 없으므로 string이 아닌 값은 없는 값으로 취급한다.
 */
export function readStringFeature(context: StrategyContext, key: string): string | undefined {
  const value = context.features[key];

  return typeof value === "string" ? value : undefined;
}

/**
 * StrategyContext가 LLM-only 입력으로 표시됐는지 판정한다.
 *
 * LLM-only frame은 참고 신호로만 허용하고 주문 후보 생성 side effect로 이어지면 안 되므로 entry guard의 첫 차단 조건이 된다.
 */
export function isLlmOnlyContext(context: StrategyContext): boolean {
  return (
    context.metadata?.llm_only === true ||
    context.metadata?.source === "llm" ||
    context.metadata?.source === "LLM" ||
    context.features.llm_only === true ||
    context.features.source === "llm" ||
    context.features.source === "LLM"
  );
}
