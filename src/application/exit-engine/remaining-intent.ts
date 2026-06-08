import type { BrokerOrder, ExitIntention, ExitOrderIntent } from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";

/**
 * 부분 체결 후 잔량을 기준으로 후속 cancel/requote 또는 남은 exit intent를 계산한다.
 *
 * 이 모듈은 PaperBroker가 반환한 partially filled order에서 잔량을 읽고,
 * dust 잔량 처리, cancel/requote 결정, 새로운 exit intent 생성을 담당한다.
 * DB나 broker 호출 같은 side effect는 없으며 순수 계산 함수로만 구성된다.
 */

/**
 * 부분 체결 후 잔량 계산 결과다.
 */
export interface PartialFillRemainingResult {
  /** 원본 broker order */
  brokerOrder: BrokerOrder;
  /** 체결된 수량 */
  filledQuantity: string;
  /** 남은 수량 (remainingQuantity > 0) */
  remainingQuantity: string;
  /** 원래 요청 수량 */
  requestedQuantity: string;
  /** dust 잔량 여부. remainingQuantity가 dustThreshold 이하이고 0보다 크면 true */
  isDust: boolean;
  /** 취소 필요 여부. 잔량이 있으면 cancel이 필요하다. */
  cancelRequired: boolean;
  /** 새로운 exit intent를 만들어야 하는지 여부 */
  requiresNewIntent: boolean;
  /** 새로운 exit intent를 만들 때 필요한 원래 exit intent 참조 (cancel/requote lineage 보존용) */
  originalExitIntention: ExitIntention;
}

/**
 * 부분 체결 옵션이다.
 */
export interface RemainingIntentOptions {
  /** dust threshold (수량 기준). 이 값 이하의 잔량은 dust로 처리한다. */
  dustThreshold?: string;
  /** cancel 후 requote 여부. true이면 새로운 exit intent를 만든다. */
  requoteAfterCancel?: boolean;
}

/**
 * 잔량 재호가 intent 생성 옵션이다.
 *
 * 같은 broker order 잔량을 재처리할 때 같은 idempotency key로 수렴해야 하므로 시간값 대신
 * cancel/requote lineage에서 온 안정 식별자를 입력으로 받는다.
 */
export interface CreateRemainingExitIntentOptions {
  /** 원 주문 또는 cancel evidence에서 온 안정 lineage id */
  lineageId?: string;
  /** 같은 lineage 안에서 여러 번 재호가할 때 호출자가 명시하는 순번 */
  requoteSequence?: number;
  /** 재호가에 사용할 새 지정가. 없으면 원 intent 가격을 유지한다. */
  requestedPrice?: string;
}

/**
 * 부분 체결된 broker order에서 잔량을 분석하고 후속 작업을 결정한다.
 *
 * 잔량이 0이면 추가 작업이 필요 없다. 잔량이 dustThreshold 이하면 dust evidence로 닫고
 * 새로운 exit intent를 만들지 않는다. 잔량이 유의미하면 cancel/requote가 필요하다.
 */
export function evaluatePartialFillRemaining(
  brokerOrder: BrokerOrder,
  originalIntent: ExitOrderIntent,
  options: RemainingIntentOptions = {},
): PartialFillRemainingResult {
  const filledQty = calculateFilledQuantity(brokerOrder, originalIntent);
  const remainingQty = brokerOrder.remainingQuantity;
  const requestedQty = originalIntent.requestedQuantity;
  const dustThreshold = options.dustThreshold ?? "0.0001";
  const exitIntention = originalIntent.metadata.position_effect;

  // 잔량이 0이면 추가 작업 불필요
  if (isZeroDecimal(remainingQty)) {
    return {
      brokerOrder,
      filledQuantity: filledQty,
      remainingQuantity: "0",
      requestedQuantity: requestedQty,
      isDust: false,
      cancelRequired: false,
      requiresNewIntent: false,
      originalExitIntention: exitIntention,
    };
  }

  // 잔량이 dust 이하인지 확인 (0보다 크고 dustThreshold 이하)
  const isDust = isDustRemaining(remainingQty, dustThreshold);
  const cancelRequired = true; // open 주문이 남아 있으므로 취소 필요

  if (isDust) {
    // dust 잔량: cancel은 하지만 새로운 exit intent는 만들지 않는다.
    return {
      brokerOrder,
      filledQuantity: filledQty,
      remainingQuantity: remainingQty,
      requestedQuantity: requestedQty,
      isDust: true,
      cancelRequired,
      requiresNewIntent: false,
      originalExitIntention: exitIntention,
    };
  }

  // 유의미한 잔량: cancel 후 requote 여부에 따라 새로운 exit intent 생성
  const requiresNewIntent = options.requoteAfterCancel ?? true;

  return {
    brokerOrder,
    filledQuantity: filledQty,
    remainingQuantity: remainingQty,
    requestedQuantity: requestedQty,
    isDust: false,
    cancelRequired,
    requiresNewIntent,
    originalExitIntention: exitIntention,
  };
}

/**
 * 부분 체결된 잔량으로 새로운 exit intent를 생성한다.
 *
 * 기존 exit intent의 idempotency lineage를 보존하며, 잔량만큼의 새로운 SELL LIMIT 주문을 만든다.
 * 잔량이 0이거나 dust면 생성하지 않는다.
 */
export function createRemainingExitIntent(
  originalIntent: ExitOrderIntent,
  remainingQuantity: string,
  options: CreateRemainingExitIntentOptions = {},
): ExitOrderIntent | null {
  if (isZeroDecimal(remainingQuantity)) {
    return null;
  }

  // 동일 잔량 재처리는 같은 key로 수렴해야 하므로 시간값이 아니라 lineage/잔량/순번으로 재호가 key를 만든다.
  const lineage = options.lineageId ?? sanitizeIdempotencySegment(remainingQuantity);
  const sequence = options.requoteSequence ?? 1;
  const requoteIdempotencyKey = `${originalIntent.idempotencyKey}-requote-${lineage}-${sequence}`;
  const requestedPrice = options.requestedPrice ?? originalIntent.requestedPrice;
  const requestedNotional = calculateNotional(requestedPrice, remainingQuantity);
  if (requestedNotional === null) {
    return null;
  }

  const remainingIntent: ExitOrderIntent = {
    exchangeId: originalIntent.exchangeId,
    market: originalIntent.market,
    strategyId: originalIntent.strategyId,
    side: "SELL",
    orderType: "LIMIT",
    requestedQuantity: remainingQuantity,
    requestedNotional,
    idempotencyKey: requoteIdempotencyKey,
    reason: `잔량 청산 재시도: ${originalIntent.reason}`,
    requestedPrice,
    timeInForce: originalIntent.timeInForce ?? "GTC",
    metadata: {
      ...originalIntent.metadata,
      exit_reason_code: `${originalIntent.metadata.exit_reason_code}_requote`,
      requote_parent_idempotency_key: originalIntent.idempotencyKey,
      requote_lineage_id: lineage,
      requote_sequence: sequence,
      requote_remaining_quantity: remainingQuantity,
    },
  };

  return remainingIntent;
}

/**
 * 한국어 사용자 메시지 생성: 부분 체결 잔량 상태를 설명한다.
 *
 * 상태·원인·영향·필요 조치를 한국어로 먼저 설명하고, 내부 식별자는 분리한다.
 */
export function formatRemainingUserMessage(result: PartialFillRemainingResult): {
  message: string;
  impact: string | null;
  action: string | null;
} {
  if (result.remainingQuantity === "0") {
    return {
      message: "청산 주문이 전량 체결되었습니다.",
      impact: null,
      action: null,
    };
  }

  if (result.isDust) {
    return {
      message: `청산 주문이 부분 체결되었으나 잔량 ${result.remainingQuantity}이(가) dust threshold 이하입니다.`,
      impact: "처리 불가 잔량으로 남습니다. 추가 청산 주문은 생성되지 않습니다.",
      action: "잔량은 dust로 처리되었습니다. 포지션 정리가 필요하면 수동으로 조치하세요.",
    };
  }

  return {
    message: `청산 주문이 부분 체결되었습니다. 체결: ${result.filledQuantity}, 잔량: ${result.remainingQuantity}`,
    impact: `잔량 ${result.remainingQuantity}에 대한 취소 및 재호가가 필요합니다.`,
    action: "미체결 잔량을 취소하고 새로운 청산 주문으로 재제출하세요.",
  };
}

// ---------------------------------------------------------------------------
// 내부 helper
// ---------------------------------------------------------------------------

/**
 * 부분 체결 시 실제 체결된 수량을 계산한다.
 *
 * broker order의 remainingQuantity와 original intent의 requestedQuantity 차이로 계산한다.
 */
function calculateFilledQuantity(
  brokerOrder: BrokerOrder,
  originalIntent: ExitOrderIntent,
): string {
  try {
    const requestedQty = parseFinancialDecimal(originalIntent.requestedQuantity);
    const remainingQty = parseFinancialDecimal(brokerOrder.remainingQuantity);
    return requestedQty.minus(remainingQty).toFixed();
  } catch {
    return "0";
  }
}

function isZeroDecimal(value: string): boolean {
  try {
    return parseFinancialDecimal(value).isZero();
  } catch {
    return false;
  }
}

function isDustRemaining(remainingQty: string, dustThreshold: string): boolean {
  try {
    const remaining = parseFinancialDecimal(remainingQty);
    const threshold = parseFinancialDecimal(dustThreshold);

    // 잔량이 0보다 크고 dustThreshold 이하이면 dust로 처리
    return remaining.greaterThan(0) && remaining.lessThanOrEqualTo(threshold);
  } catch {
    return false;
  }
}

function sanitizeIdempotencySegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized.length > 0 ? sanitized : "remaining";
}

function calculateNotional(price: string, quantity: string): string | null {
  try {
    const priceDecimal = parseFinancialDecimal(price);
    const quantityDecimal = parseFinancialDecimal(quantity);
    if (!priceDecimal.greaterThan(0) || !quantityDecimal.greaterThan(0)) {
      return null;
    }
    return priceDecimal.mul(quantityDecimal).toFixed();
  } catch {
    return null;
  }
}
