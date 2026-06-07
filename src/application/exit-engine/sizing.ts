import { Decimal } from "decimal.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { ExitPolicySnapshot, ExitPositionScope, ExitSizing } from "../../domain/index.js";

/**
 * ExitSizing 옵션이다.
 */
export interface ExitSizingOptions {
  /** 요청 청산 수량 */
  requestedQuantity: string;
  /** 현재 open position scope */
  positionScope: ExitPositionScope;
  /** exit 정책 snapshot */
  policySnapshot: ExitPolicySnapshot;
  /** 현재 시장가 (notional 계산용) */
  currentPrice: string;
}

/**
 * exit 수량을 검증하고 ExitSizing 결과를 생성한다.
 *
 * open position 수량 초과 시 조용히 clamp하지 않고 차단 evidence를 남긴다.
 * dust/min-order 미달 시 broker submit으로 넘기지 않고 reason을 분리한다.
 */
export function evaluateExitSizing(options: ExitSizingOptions): ExitSizing {
  const requestedQty = parseDecimal(options.requestedQuantity);
  const totalQty = parseDecimal(options.positionScope.totalQuantity);
  const dustThreshold = parseDecimal(options.policySnapshot.dustThreshold);
  const minOrderNotional = parseDecimal(options.policySnapshot.minOrderNotional);
  const currentPrice = parseDecimal(options.currentPrice);

  // 파싱 실패 시 차단
  if (requestedQty === undefined || totalQty === undefined || dustThreshold === undefined || minOrderNotional === undefined || currentPrice === undefined) {
    return invalid("exit_sizing_parse_error", "청산 수량 또는 정책 값을 파싱할 수 없습니다.", options.requestedQuantity);
  }

  // 정책 snapshot 값이 비정상이면 최소 주문금액/dust 판단을 신뢰할 수 없으므로 주문 후보 생성을 차단한다.
  if (!minOrderNotional.greaterThan(0)) {
    return invalid(
      "exit_policy_invalid",
      "최소 주문금액 정책값이 유효하지 않습니다. 0보다 큰 금액이어야 합니다.",
      options.requestedQuantity,
    );
  }

  if (dustThreshold.isNegative()) {
    return invalid(
      "exit_policy_invalid",
      "dust threshold 정책값이 유효하지 않습니다. 0 이상이어야 합니다.",
      options.requestedQuantity,
    );
  }

  // 현재가가 0 이하이면 주문 금액 계산이 왜곡되므로 broker submit 후보로 넘기지 않는다.
  if (!currentPrice.greaterThan(0)) {
    return invalid(
      "exit_price_invalid",
      "현재가가 유효하지 않습니다. 0보다 큰 가격이어야 합니다.",
      options.requestedQuantity,
    );
  }

  // open position quantity가 0이면 exit intent를 만들지 않는다.
  if (totalQty.isZero() || totalQty.isNegative()) {
    return invalid(
      "exit_no_position",
      "청산할 포지션이 없습니다. open position 수량이 0이거나 음수입니다.",
      options.requestedQuantity,
    );
  }

  // 요청 수량이 0 이하면 차단
  if (requestedQty.isZero() || requestedQty.isNegative()) {
    return invalid(
      "exit_quantity_invalid",
      "청산 요청 수량이 0 이하입니다.",
      options.requestedQuantity,
    );
  }

  // 포지션 초과 검증 — Math.min 보정 없이 차단
  if (requestedQty.greaterThan(totalQty)) {
    return {
      requestedQuantity: requestedQty.toFixed(),
      executableQuantity: "0",
      dustQuantity: "0",
      belowMinOrderNotional: false,
      exceedsPosition: true,
      exceedsPositionReason: `청산 요청 수량(${requestedQty.toFixed()})이 보유 수량(${totalQty.toFixed()})을 초과합니다. 주문을 차단합니다.`,
      valid: false,
      rejectionReason: "position_exceeded",
    };
  }

  // dust 잔량 계산
  const remainingAfterSell = totalQty.minus(requestedQty);
  const hasDust = remainingAfterSell.greaterThan(0) && remainingAfterSell.lessThanOrEqualTo(dustThreshold);

  // 최소 주문금액 검증: executableQuantity * currentPrice
  const executableQty = requestedQty;
  const executableNotional = executableQty.mul(currentPrice);
  const remainingNotional = remainingAfterSell.mul(currentPrice);

  if (executableNotional.lessThan(minOrderNotional)) {
    return {
      requestedQuantity: requestedQty.toFixed(),
      executableQuantity: "0",
      dustQuantity: "0",
      belowMinOrderNotional: true,
      belowMinOrderReason: `청산 주문 예상 금액(${executableNotional.toFixed()} KRW)이 최소 주문금액(${minOrderNotional.toFixed()} KRW) 미만입니다.`,
      exceedsPosition: false,
      valid: false,
      rejectionReason: "below_min_order_notional",
    };
  }

  if (remainingAfterSell.greaterThan(0) && remainingNotional.lessThan(minOrderNotional)) {
    return {
      requestedQuantity: requestedQty.toFixed(),
      executableQuantity: "0",
      dustQuantity: "0",
      belowMinOrderNotional: false,
      remainingBelowMinOrderNotional: true,
      remainingBelowMinOrderReason: `청산 후 잔여 포지션 예상 금액(${remainingNotional.toFixed()} KRW)이 최소 주문금액(${minOrderNotional.toFixed()} KRW) 미만입니다. 유의미한 잔여 포지션을 남기지 않도록 주문 후보 생성을 차단합니다.`,
      exceedsPosition: false,
      valid: false,
      rejectionReason: "remaining_below_min_order_notional",
    };
  }

  if (hasDust) {
    return {
      requestedQuantity: requestedQty.toFixed(),
      executableQuantity: "0",
      dustQuantity: remainingAfterSell.toFixed(),
      dustReason: `청산 후 잔량(${remainingAfterSell.toFixed()})이 dust threshold(${dustThreshold.toFixed()}) 이하입니다. "실제 0"이 아닌 "처리 불가 잔량"으로 구분하고 주문 후보 생성을 차단합니다.`,
      belowMinOrderNotional: false,
      exceedsPosition: false,
      valid: false,
      rejectionReason: "dust_remainder",
    };
  }

  const result: ExitSizing = {
    requestedQuantity: requestedQty.toFixed(),
    executableQuantity: executableQty.toFixed(),
    dustQuantity: "0",
    belowMinOrderNotional: false,
    exceedsPosition: false,
    valid: true,
  };
  return result;
}

/**
 * ExitSizing 결과를 받아 한국어 사용자 메시지를 생성한다.
 *
 * 내부 code를 노출하지 않고 상태·원인·영향·필요 조치를 우선 설명한다.
 */
export function formatSizingUserMessage(sizing: ExitSizing): string {
  if (sizing.valid) {
    let message = `청산 수량 ${sizing.executableQuantity}이(가) 유효합니다.`;
    if (sizing.dustReason !== undefined) {
      message += ` ${sizing.dustReason}`;
    }
    return message;
  }

  if (sizing.exceedsPosition) {
    return sizing.exceedsPositionReason ?? "청산 수량이 보유 수량을 초과하여 주문이 차단되었습니다.";
  }

  if (sizing.belowMinOrderNotional) {
    return sizing.belowMinOrderReason ?? "청산 주문 금액이 최소 주문금액 미만입니다.";
  }

  if (sizing.remainingBelowMinOrderNotional === true) {
    return sizing.remainingBelowMinOrderReason ?? "청산 후 잔여 포지션 금액이 최소 주문금액 미만입니다.";
  }

  if (sizing.rejectionReason === "dust_remainder" && sizing.dustReason !== undefined) {
    return `${sizing.dustReason} 전체 청산 또는 요청 수량 재계산이 필요합니다.`;
  }

  // raw rejectionReason을 사용자-facing 메시지로 변환한다.
  // 내부 code를 첫 화면에 노출하지 않고 상태·원인·필요 조치를 한국어로 설명한다.
  const mapped = REJECTION_MESSAGE_MAP[sizing.rejectionReason ?? ""];
  if (mapped !== undefined) {
    return mapped;
  }

  return "청산 수량 검증에 실패했습니다.";
}

// ---------------------------------------------------------------------------
// 내부 helper
// ---------------------------------------------------------------------------

/**
 * ExitSizing rejectionReason을 한국어 사용자-facing 메시지로 매핑한다.
 *
 * 내부 식별자를 노출하지 않고 상태·원인·필요 조치를 우선 설명한다.
 */
const REJECTION_MESSAGE_MAP: Record<string, string> = {
  exit_sizing_parse_error: "청산 수량 또는 정책 값을 파싱할 수 없습니다. 입력 값을 확인하세요.",
  exit_policy_invalid: "청산 정책값이 유효하지 않습니다. 최소 주문금액과 dust threshold 설정을 확인하세요.",
  exit_price_invalid: "현재가가 유효하지 않습니다. 0보다 큰 가격으로 다시 평가해야 합니다.",
  dust_remainder: "청산 후 처리 불가 잔량이 남아 주문 후보 생성을 차단했습니다. 전체 청산 또는 요청 수량 재계산이 필요합니다.",
  remaining_below_min_order_notional: "청산 후 잔여 포지션 금액이 최소 주문금액 미만입니다. 전체 청산 또는 요청 수량 재계산이 필요합니다.",
  exit_no_position: "청산할 포지션이 없습니다. open position 수량이 0이거나 음수입니다.",
  exit_quantity_invalid: "청산 요청 수량이 0 이하입니다. 유효한 수량을 입력하세요.",
  position_exceeded: "청산 수량이 보유 수량을 초과하여 주문이 차단되었습니다.",
  below_min_order_notional: "청산 주문 금액이 최소 주문금액 미만입니다.",
};

function parseDecimal(value: string): Decimal | undefined {
  try {
    return parseFinancialDecimal(value);
  } catch {
    return undefined;
  }
}

function invalid(
  rejectionReason: string,
  message: string,
  requestedQuantity: string,
): ExitSizing {
  const result: ExitSizing = {
    requestedQuantity,
    executableQuantity: "0",
    dustQuantity: "0",
    belowMinOrderNotional: false,
    exceedsPosition: false,
    valid: false,
    rejectionReason,
  };
  if (rejectionReason === "exit_quantity_invalid" || rejectionReason === "position_exceeded") {
    result.exceedsPositionReason = message;
  }
  if (rejectionReason === "below_min_order_notional") {
    result.belowMinOrderReason = message;
  }
  return result;
}
