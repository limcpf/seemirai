import { Decimal } from "decimal.js";
import type { MarketCode } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  PaperPnlFillInput,
  PaperPnlMarkPriceInput,
  PaperPnlSummary,
  PaperPnlSummaryInput,
} from "./types.js";

interface MutablePositionLedger {
  quantity: Decimal;
  costBasisKrw: Decimal;
}

/**
 * paper PnL 입력이 ledger invariant를 깼을 때 발생하는 오류다.
 *
 * 계산기는 외부 side effect 없이 실패하지만, 초과 매도나 음수 금액을 조용히 0으로 보정하면 운영 손익 report가
 * 잘못된 evidence가 되므로 호출자가 입력 source를 고치도록 명시적으로 예외를 던진다.
 */
export class PaperPnlSummaryInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PaperPnlSummaryInvariantError";
  }
}

/**
 * paper fill ledger를 KRW 기준 PnL summary로 누적한다.
 *
 * 이 함수는 평균단가, 가상 현금, 실현손익, 미실현손익, 수수료를 순수 계산으로만 만든다. 호출 경계는 runner나
 * report formatter이며, DB write, broker 호출, 외부 API 조회 side effect는 없다. 수수료는 매수 cost basis와
 * 매도 순수취액에 즉시 반영되어 `realizedPnlKrw + unrealizedPnlKrw = totalPnlKrw` invariant를 유지한다.
 */
export function createPaperPnlSummary(input: PaperPnlSummaryInput): PaperPnlSummary {
  const startingCashKrw = parseNonNegativeDecimal(input.startingCashKrw, "startingCashKrw");
  let cashKrw = startingCashKrw;
  let realizedPnlKrw = new Decimal(0);
  let totalFeesKrw = new Decimal(0);
  const filledOrderIds = new Set<string>();
  const positions = new Map<MarketCode, MutablePositionLedger>();

  for (const fill of input.fills) {
    const filledQuantity = parseNonNegativeDecimal(fill.filledQuantity, "filledQuantity");
    const totalFillNotional = parseNonNegativeDecimal(fill.totalFillNotional, "totalFillNotional");
    const totalFee = parseNonNegativeDecimal(fill.totalFee ?? "0", "totalFee");
    if (filledQuantity.isZero()) {
      continue;
    }

    // 한 주문이 여러 호가 level로 쪼개져도 report의 체결 주문 수는 한 번만 증가해야 한다.
    filledOrderIds.add(fill.orderId);
    totalFeesKrw = totalFeesKrw.plus(totalFee);

    if (fill.side === "BUY") {
      const fillCostKrw = totalFillNotional.plus(totalFee);
      cashKrw = cashKrw.minus(fillCostKrw);
      const position = getOrCreatePosition(positions, fill.market);
      position.quantity = position.quantity.plus(filledQuantity);
      position.costBasisKrw = position.costBasisKrw.plus(fillCostKrw);
      continue;
    }

    const position = getOrCreatePosition(positions, fill.market);
    if (position.quantity.lessThan(filledQuantity)) {
      // paper broker는 short sell을 만들지 않아야 하므로 초과 매도 입력은 손익 계산 전에 중단한다.
      throw new PaperPnlSummaryInvariantError(`SELL fill exceeds open position for ${fill.market}`);
    }

    const averageCostKrw = position.quantity.isZero()
      ? new Decimal(0)
      : position.costBasisKrw.div(position.quantity);
    const realizedCostBasisKrw = averageCostKrw.times(filledQuantity);
    const sellProceedsAfterFeeKrw = totalFillNotional.minus(totalFee);
    realizedPnlKrw = realizedPnlKrw.plus(sellProceedsAfterFeeKrw.minus(realizedCostBasisKrw));
    cashKrw = cashKrw.plus(sellProceedsAfterFeeKrw);
    position.quantity = position.quantity.minus(filledQuantity);
    position.costBasisKrw = position.quantity.isZero()
      ? new Decimal(0)
      : position.costBasisKrw.minus(realizedCostBasisKrw);
  }

  const markToMarket = calculateMarkToMarket(positions, input.markPrices ?? []);
  const totalPnlKrw =
    markToMarket.unrealizedPnlKrw === null ? null : realizedPnlKrw.plus(markToMarket.unrealizedPnlKrw);
  const totalReturnBps =
    totalPnlKrw === null || startingCashKrw.isZero()
      ? null
      : totalPnlKrw.div(startingCashKrw).times(10000);

  const filledOrderCount = filledOrderIds.size;
  return {
    startingCashKrw: startingCashKrw.toFixed(),
    endingCashKrw: cashKrw.toFixed(),
    positionMarketValueKrw: decimalOrNullToFixed(markToMarket.positionMarketValueKrw),
    realizedPnlKrw: realizedPnlKrw.toFixed(),
    unrealizedPnlKrw: decimalOrNullToFixed(markToMarket.unrealizedPnlKrw),
    totalPnlKrw: decimalOrNullToFixed(totalPnlKrw),
    totalReturnBps: decimalOrNullToFixed(totalReturnBps),
    totalFeesKrw: totalFeesKrw.toFixed(),
    submittedOrderCount: input.submittedOrderCount ?? filledOrderCount,
    filledOrderCount,
  };
}

function calculateMarkToMarket(
  positions: ReadonlyMap<MarketCode, MutablePositionLedger>,
  markPrices: readonly PaperPnlMarkPriceInput[],
): { positionMarketValueKrw: Decimal | null; unrealizedPnlKrw: Decimal | null } {
  const markPriceByMarket = new Map<MarketCode, Decimal>();
  for (const markPrice of markPrices) {
    markPriceByMarket.set(markPrice.market, parseNonNegativeDecimal(markPrice.priceKrw, "priceKrw"));
  }

  let positionMarketValueKrw = new Decimal(0);
  let unrealizedPnlKrw = new Decimal(0);
  for (const [market, position] of positions.entries()) {
    if (position.quantity.isZero()) {
      continue;
    }

    const markPrice = markPriceByMarket.get(market);
    if (markPrice === undefined) {
      // 평가가 없이 미청산 포지션을 0원으로 간주하면 손익 방향을 왜곡하므로 MTM 의존 값만 null로 보류한다.
      return {
        positionMarketValueKrw: null,
        unrealizedPnlKrw: null,
      };
    }

    const marketValueKrw = position.quantity.times(markPrice);
    positionMarketValueKrw = positionMarketValueKrw.plus(marketValueKrw);
    unrealizedPnlKrw = unrealizedPnlKrw.plus(marketValueKrw.minus(position.costBasisKrw));
  }

  return {
    positionMarketValueKrw,
    unrealizedPnlKrw,
  };
}

function getOrCreatePosition(
  positions: Map<MarketCode, MutablePositionLedger>,
  market: MarketCode,
): MutablePositionLedger {
  const existing = positions.get(market);
  if (existing !== undefined) {
    return existing;
  }

  const position: MutablePositionLedger = {
    quantity: new Decimal(0),
    costBasisKrw: new Decimal(0),
  };
  positions.set(market, position);

  return position;
}

function parseNonNegativeDecimal(value: string, fieldName: string): Decimal {
  const decimal = parseFinancialDecimal(value);
  if (decimal.isNegative()) {
    throw new PaperPnlSummaryInvariantError(`${fieldName} must be non-negative`);
  }

  return decimal;
}

function decimalOrNullToFixed(value: Decimal | null): string | null {
  return value === null ? null : value.toFixed();
}
