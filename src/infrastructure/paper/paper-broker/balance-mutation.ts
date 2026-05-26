import type { PaperFillSimulationResult } from "../../../application/execution/index.js";
import type { MarketCode, NumericString, OrderIntent } from "../../../domain/index.js";
import {
  addDecimalStrings,
  isPositiveDecimalString,
  multiplyDecimalStrings,
  negateDecimalString,
  normalizeCurrency,
  subtractDecimalStrings,
} from "./decimal-math.js";
import type {
  MarketCurrencies,
  PaperBrokerBalanceMutationSummary,
  PaperBrokerBalanceValidationResult,
  PaperBrokerOrderState,
} from "./types.js";

/**
 * fill simulation 결과를 제출 시점 잔고 delta로 변환한다.
 *
 * BUY는 quote를 차감하고 base를 증가시키며, SELL은 base를 차감하고 quote를 증가시킨다. open 수량은 locked 잔고로 남겨
 * 이후 cancel/requote가 같은 수량을 해제할 수 있게 한다.
 */
export function createSubmissionBalanceMutation(
  intent: OrderIntent,
  simulation: PaperFillSimulationResult,
): PaperBrokerBalanceMutationSummary {
  const { baseCurrency, quoteCurrency } = parseMarketCurrencies(intent.market);
  const filledQuantity = simulation.filledQuantity;
  const openQuantity = simulation.openQuantity;
  const totalFillNotional = simulation.totalFillNotional ?? "0";
  const totalFee = simulation.totalFee ?? "0";
  let quoteAvailableDelta = "0";
  let quoteLockedDelta = "0";
  let baseAvailableDelta = "0";
  let baseLockedDelta = "0";

  if (intent.side === "BUY") {
    const fillQuoteDebit = addDecimalStrings(totalFillNotional, totalFee);
    const openQuoteLock = calculateOpenQuoteLock(intent, openQuantity);

    quoteAvailableDelta = negateDecimalString(addDecimalStrings(fillQuoteDebit, openQuoteLock));
    quoteLockedDelta = openQuoteLock;
    baseAvailableDelta = filledQuantity;
  } else {
    const fillQuoteCredit = subtractDecimalStrings(totalFillNotional, totalFee);

    quoteAvailableDelta = fillQuoteCredit;
    baseAvailableDelta = negateDecimalString(addDecimalStrings(filledQuantity, openQuantity));
    baseLockedDelta = openQuantity;
  }

  return {
    base_currency: baseCurrency,
    quote_currency: quoteCurrency,
    filled_quantity: filledQuantity,
    open_quantity: openQuantity,
    canceled_quantity: simulation.canceledQuantity,
    quote_available_delta: quoteAvailableDelta,
    quote_locked_delta: quoteLockedDelta,
    base_available_delta: baseAvailableDelta,
    base_locked_delta: baseLockedDelta,
  };
}

/**
 * fill simulation과 balance validation 결과를 broker 주문 상태로 정규화한다.
 *
 * 잔고 부족은 simulator가 만든 체결 후보보다 우선하므로 REJECTED 상태로 닫고 balance side effect 적용 여부를 false로 남긴다.
 */
export function createOrderStateFromSimulation(
  simulation: PaperFillSimulationResult,
  balanceValidation: PaperBrokerBalanceValidationResult,
): PaperBrokerOrderState {
  if (!balanceValidation.valid) {
    return {
      status: "REJECTED",
      remainingQuantity: "0",
      balanceMutationApplied: false,
      balanceRejection: balanceValidation.rejection,
    };
  }

  return {
    status: simulation.orderStatus,
    remainingQuantity: simulation.openQuantity,
    balanceMutationApplied: true,
  };
}

/**
 * QUOTE-BASE market code를 balance mutation에 필요한 통화쌍으로 분리한다.
 *
 * 형식이 깨진 market은 주문 잔고 계산을 진행하면 잘못된 통화를 움직이므로 즉시 예외로 닫는다.
 */
export function parseMarketCurrencies(market: MarketCode): MarketCurrencies {
  const separatorIndex = market.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === market.length - 1) {
    throw new Error(`Paper broker requires market codes in QUOTE-BASE format: ${market}`);
  }

  return {
    quoteCurrency: normalizeCurrency(market.slice(0, separatorIndex)),
    baseCurrency: normalizeCurrency(market.slice(separatorIndex + 1)),
  };
}

function calculateOpenQuoteLock(intent: OrderIntent, openQuantity: NumericString): NumericString {
  if (intent.orderType !== "LIMIT" || !isPositiveDecimalString(openQuantity)) {
    return "0";
  }

  return multiplyDecimalStrings(openQuantity, intent.requestedPrice);
}
