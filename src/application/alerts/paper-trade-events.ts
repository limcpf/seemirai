import type { AlertSeverity } from "../ports/index.js";
import type { JsonRecord, OrderSide, TimestampInput } from "../../domain/index.js";
import type { AlertDispatchRequest } from "./index.js";

export const paperTradeAlertSource = "paper_trade_event";
export const paperTradeAlertType = "paper_trade_event";

/**
 * paper 매매 이벤트 알림에서 운영자가 구분해야 하는 lifecycle와 예외 이벤트 목록이다.
 *
 * 이 값은 broker/persistence가 만든 주문·체결 evidence를 알림 후보로 바꿀 때의 입력 경계다. 주문 제출, 부분체결, 체결,
 * 취소/재호가, 리스크 차단, 요약 이벤트를 같은 mapper에서 다루되 실제 broker side effect나 DB write를 수행하지 않는다.
 * 새 이벤트를 추가하면 severity, cooldown 정책, Telegram 사용자 문구를 같은 정책 테이블에 함께 추가해야 한다.
 */
export type PaperTradeAlertEventKind =
  | "ORDER_SUBMITTED"
  | "ORDER_PARTIALLY_FILLED"
  | "ORDER_FILLED"
  | "ORDER_CANCELED"
  | "REQUOTE_COMPLETED"
  | "RISK_BLOCKED"
  | "SLIPPAGE_THRESHOLD_EXCEEDED"
  | "PARTIAL_FILL_STALE"
  | "CANCEL_REQUOTE_FAILED"
  | "ACCOUNTING_MISMATCH"
  | "OPERATOR_REVIEW_REQUIRED"
  | "STRATEGY_SIGNAL_SUMMARY"
  | "DISCARDED_CANDIDATES_SUMMARY"
  | "NORMAL_LIFECYCLE_SUMMARY";

/**
 * paper 매매 이벤트 알림의 전송 정책 분류다.
 *
 * `immediate`는 P1 운영 개입 후보, `cooldown`은 P2 lifecycle 알림, `summary`는 P3 요약 알림을 뜻한다. dispatch 계층은
 * severity를 기준으로 durable/memory cooldown을 선택하고, 이 값은 Telegram 추적 정보와 문서화된 운영 정책을 맞추기 위한
 * metadata로만 사용한다.
 */
export type PaperTradeAlertDeliveryPolicy = "immediate" | "cooldown" | "summary";

/**
 * paper 주문·체결 evidence를 alert dispatch 요청으로 바꾸기 위한 입력이다.
 *
 * 호출자는 DB commit 또는 broker 결과가 확정된 뒤 이 구조를 만든다. mapper는 입력 값을 Telegram과 cooldown이 공유할
 * payload로 정규화하지만, 주문 상태 변경, 체결 저장, provider 호출 같은 외부 side effect는 수행하지 않는다. market,
 * strategyId, side, quantity는 fingerprint와 첫 화면 메시지의 최소 invariant이며, orderId/idempotencyKey/correlationId는
 * 추적 정보로 분리해 보존한다.
 */
export interface PaperTradeAlertInput {
  environment: string;
  runMode: string;
  eventKind: PaperTradeAlertEventKind;
  market: string;
  strategyId: string;
  side: OrderSide;
  quantity: string;
  occurredAt?: TimestampInput;
  orderId?: string;
  idempotencyKey?: string;
  correlationId?: string;
  requestedPrice?: string;
  fillPrice?: string;
  requestedNotional?: string;
  feeAmount?: string;
  feeCurrency?: string;
  slippageBps?: string;
  remainingQuantity?: string;
  details?: JsonRecord;
}

/**
 * paper 매매 이벤트 종류별 알림 정책이다.
 *
 * policy는 severity, cooldown 정책, reason code, 사용자 문구를 한 번에 고정한다. reason code는 fingerprint와 audit/retry
 * 경계의 안정 식별자이고, status/cause/impact/action은 Telegram 첫 화면에 노출되는 한국어 운영 문구다.
 */
interface PaperTradeAlertPolicy {
  severity: AlertSeverity;
  deliveryPolicy: PaperTradeAlertDeliveryPolicy;
  reasonCode: string;
  eventLabel: string;
  statusText: string;
  causeText: string;
  impactText: string;
  operatorAction: string;
}

const paperTradeAlertPolicies: Record<PaperTradeAlertEventKind, PaperTradeAlertPolicy> = {
  ORDER_SUBMITTED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_order_submitted",
    eventLabel: "주문 제출",
    statusText: "PAPER 주문이 broker 경계로 제출됐습니다.",
    causeText: "비용 모델과 리스크 게이트를 통과한 주문 후보가 제출 단계로 전진했습니다.",
    impactText: "같은 fingerprint의 반복 제출 알림은 cooldown으로 묶어 운영 소음을 줄입니다.",
    operatorAction: "동일 주문 키가 반복되지 않는지와 후속 체결 또는 취소 이벤트가 이어지는지 확인해 주세요.",
  },
  ORDER_PARTIALLY_FILLED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_order_partially_filled",
    eventLabel: "부분체결",
    statusText: "PAPER 주문 일부가 체결됐습니다.",
    causeText: "fill simulator가 주문 수량 중 일부 체결을 기록했습니다.",
    impactText: "잔량은 후속 체결, 취소, 재호가 판단 대상입니다.",
    operatorAction: "잔량과 체결 품질이 전략 기대값 안에 남아 있는지 확인해 주세요.",
  },
  ORDER_FILLED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_order_filled",
    eventLabel: "전체체결",
    statusText: "PAPER 주문이 전체 체결됐습니다.",
    causeText: "fill simulator가 주문 잔량을 모두 체결 처리했습니다.",
    impactText: "포지션, 수수료, 슬리피지 집계가 daily report 입력으로 반영됩니다.",
    operatorAction: "체결가와 비용 metric이 예상 범위인지 daily report에서 이어서 확인해 주세요.",
  },
  ORDER_CANCELED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_order_canceled",
    eventLabel: "주문 취소",
    statusText: "PAPER 주문이 취소됐습니다.",
    causeText: "미체결 잔량 또는 운영 차단 조건 때문에 주문 lifecycle이 취소로 종료됐습니다.",
    impactText: "취소된 잔량은 포지션으로 반영되지 않고, 취소 비용은 가능할 때 리포트 품질 metric에 남습니다.",
    operatorAction: "취소 사유가 반복되면 호가 최신성, spread, 전략 진입 조건을 확인해 주세요.",
  },
  REQUOTE_COMPLETED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_requote_completed",
    eventLabel: "재호가 완료",
    statusText: "PAPER 주문의 재호가가 완료됐습니다.",
    causeText: "기존 가격 조건이 더 이상 유효하지 않아 취소 후 새 가격 조건으로 조정됐습니다.",
    impactText: "재호가 비용과 지연은 체결 품질 판단에 반영됩니다.",
    operatorAction: "재호가 빈도가 높으면 전략 가격 여유와 호가 깊이를 확인해 주세요.",
  },
  RISK_BLOCKED: {
    severity: "P2",
    deliveryPolicy: "cooldown",
    reasonCode: "paper_risk_blocked",
    eventLabel: "리스크 차단",
    statusText: "PAPER 주문 후보가 리스크 게이트에서 차단됐습니다.",
    causeText: "계정, 노출, 손실, 시장 데이터 조건 중 하나가 주문 허용 기준을 통과하지 못했습니다.",
    impactText: "실거래 전환 가능성 판단을 위해 차단 사유가 daily report에 누적됩니다.",
    operatorAction: "반복 차단되는 전략과 마켓의 한도 입력, 데이터 최신성, kill switch 상태를 확인해 주세요.",
  },
  SLIPPAGE_THRESHOLD_EXCEEDED: {
    severity: "P1",
    deliveryPolicy: "immediate",
    reasonCode: "paper_slippage_threshold_exceeded",
    eventLabel: "슬리피지 임계값 초과",
    statusText: "PAPER 주문 체결 품질이 기준을 벗어났습니다.",
    causeText: "실제 체결가가 요청 가격 대비 허용 슬리피지를 초과했습니다.",
    impactText: "전략 기대값이 비용 차감 후 음수로 바뀔 수 있습니다.",
    operatorAction: "해당 전략과 마켓의 가격/호가 상태를 확인하고 필요하면 전략을 일시 중지해 주세요.",
  },
  PARTIAL_FILL_STALE: {
    severity: "P1",
    deliveryPolicy: "immediate",
    reasonCode: "paper_partial_fill_stale",
    eventLabel: "부분체결 장기화",
    statusText: "PAPER 주문 잔량이 기준 시간보다 오래 남아 있습니다.",
    causeText: "부분체결 이후 잔량이 체결, 취소, 재호가 중 하나로 수렴하지 않았습니다.",
    impactText: "실거래 전환 시 미체결 리스크와 기회비용이 커질 수 있습니다.",
    operatorAction: "잔량 취소나 재호가 조건이 정상 동작하는지 확인해 주세요.",
  },
  CANCEL_REQUOTE_FAILED: {
    severity: "P1",
    deliveryPolicy: "immediate",
    reasonCode: "paper_cancel_requote_failed",
    eventLabel: "취소/재호가 실패",
    statusText: "PAPER 주문 취소 또는 재호가가 완료되지 않았습니다.",
    causeText: "주문 상태 전이가 예상한 취소/재호가 경로로 수렴하지 못했습니다.",
    impactText: "실거래 전환 전 broker 전이 경계와 idempotency 처리를 점검해야 합니다.",
    operatorAction: "주문 이벤트 순서, broker 응답, pending cancel job 상태를 확인해 주세요.",
  },
  ACCOUNTING_MISMATCH: {
    severity: "P1",
    deliveryPolicy: "immediate",
    reasonCode: "paper_accounting_mismatch",
    eventLabel: "주문/체결 회계 불일치",
    statusText: "PAPER 주문과 체결 회계가 맞지 않습니다.",
    causeText: "주문 잔량, 체결 수량, 포지션 또는 수수료 집계가 서로 일치하지 않습니다.",
    impactText: "실거래 전환 가능성 판단과 daily report 수치 신뢰도가 떨어집니다.",
    operatorAction: "주문 이벤트, fills, positions, PnL snapshot을 같은 correlation id로 대조해 주세요.",
  },
  OPERATOR_REVIEW_REQUIRED: {
    severity: "P1",
    deliveryPolicy: "immediate",
    reasonCode: "paper_operator_review_required",
    eventLabel: "운영자 확인 필요",
    statusText: "PAPER 주문 흐름이 자동 판단만으로 복구하기 어려운 상태입니다.",
    causeText: "리스크 차단이나 상태 전이가 반복되어 사람이 근거를 확인해야 합니다.",
    impactText: "추가 주문 제출을 보수적으로 보류하고 운영자 판단을 기다리는 것이 안전합니다.",
    operatorAction: "최근 risk/audit/order evidence를 확인하고 필요하면 kill switch 상태를 전환해 주세요.",
  },
  STRATEGY_SIGNAL_SUMMARY: {
    severity: "P3",
    deliveryPolicy: "summary",
    reasonCode: "paper_strategy_signal_summary",
    eventLabel: "전략 신호 요약",
    statusText: "PAPER 전략 신호가 요약 대상에 누적됐습니다.",
    causeText: "정상 신호 반복은 단건 알림보다 요약으로 보는 편이 운영 판단에 적합합니다.",
    impactText: "전략별 신호 빈도와 주문 전환율을 daily report와 함께 비교할 수 있습니다.",
    operatorAction: "요약 주기마다 신호 품질과 실제 주문 전환 결과를 확인해 주세요.",
  },
  DISCARDED_CANDIDATES_SUMMARY: {
    severity: "P3",
    deliveryPolicy: "summary",
    reasonCode: "paper_discarded_candidates_summary",
    eventLabel: "폐기 후보 요약",
    statusText: "PAPER 주문 후보 폐기 이벤트가 요약 대상에 누적됐습니다.",
    causeText: "여러 폐기 사유가 반복되어 단건 알림 대신 집계로 확인합니다.",
    impactText: "비용, 리스크, 데이터 최신성 중 어떤 조건이 주문 전환을 막는지 비교할 수 있습니다.",
    operatorAction: "상위 폐기 사유와 전략별 분포를 daily report에서 확인해 주세요.",
  },
  NORMAL_LIFECYCLE_SUMMARY: {
    severity: "P3",
    deliveryPolicy: "summary",
    reasonCode: "paper_normal_lifecycle_summary",
    eventLabel: "정상 lifecycle 요약",
    statusText: "PAPER 주문 lifecycle 정상 이벤트가 요약 대상에 누적됐습니다.",
    causeText: "반복되는 정상 제출, 체결, 취소 이벤트를 단건 알림으로 보내지 않습니다.",
    impactText: "운영자는 요약으로 체결률과 반복 패턴을 확인할 수 있습니다.",
    operatorAction: "요약 결과에서 체결률, 취소율, 재호가 빈도가 기준을 벗어나는지 확인해 주세요.",
  },
};

/**
 * paper 매매 이벤트 evidence를 alert dispatch 요청으로 변환한다.
 *
 * 반환값은 `dispatchAlertWithCooldown`에 그대로 넘길 수 있는 순수 데이터다. mapper는 P1 즉시 전송, P2 cooldown, P3 요약
 * 정책을 eventKind별로 고정하고, Telegram 첫 화면에 필요한 한국어 상태/원인/영향/필요 조치와 추적용 내부 식별자를 metadata에
 * 분리한다. provider 실패나 cooldown 처리는 이 함수 밖의 alert dispatch 계층 책임이며, 이 함수 자체는 외부 side effect가 없다.
 */
export function createPaperTradeAlertRequest(input: PaperTradeAlertInput): AlertDispatchRequest {
  const policy = paperTradeAlertPolicies[input.eventKind];

  return {
    environment: input.environment,
    runMode: input.runMode,
    severity: policy.severity,
    alertType: paperTradeAlertType,
    market: input.market,
    strategyId: input.strategyId,
    reasonCode: policy.reasonCode,
    title: `PAPER 매매 알림: ${policy.eventLabel}`,
    body: formatPaperTradeAlertBody(input, policy),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    metadata: createPaperTradeAlertMetadata(input, policy),
  };
}

function createPaperTradeAlertMetadata(
  input: PaperTradeAlertInput,
  policy: PaperTradeAlertPolicy,
): JsonRecord {
  const metadata: JsonRecord = {
    source: paperTradeAlertSource,
    paper_mode: "PAPER",
    event_kind: input.eventKind,
    event_label: policy.eventLabel,
    delivery_policy: policy.deliveryPolicy,
    reason_code: policy.reasonCode,
    status_text: policy.statusText,
    cause_text: policy.causeText,
    impact_text: policy.impactText,
    operator_action: policy.operatorAction,
    market: input.market,
    strategy_id: input.strategyId,
    side: input.side,
    quantity: input.quantity,
  };

  // 선택 식별자는 첫 화면 대신 추적 정보로 내려 운영 증거 연결성을 보존한다.
  assignIfDefined(metadata, "order_id", input.orderId);
  assignIfDefined(metadata, "idempotency_key", input.idempotencyKey);
  assignIfDefined(metadata, "correlation_id", input.correlationId);
  assignIfDefined(metadata, "requested_price", input.requestedPrice);
  assignIfDefined(metadata, "fill_price", input.fillPrice);
  assignIfDefined(metadata, "requested_notional", input.requestedNotional);
  assignIfDefined(metadata, "fee_amount", input.feeAmount);
  assignIfDefined(metadata, "fee_currency", input.feeCurrency);
  assignIfDefined(metadata, "slippage_bps", input.slippageBps);
  assignIfDefined(metadata, "remaining_quantity", input.remainingQuantity);
  assignIfDefined(metadata, "details", input.details);

  return metadata;
}

function formatPaperTradeAlertBody(
  input: PaperTradeAlertInput,
  policy: PaperTradeAlertPolicy,
): string {
  return joinDefinedLines([
    `상태: ${policy.statusText}`,
    `원인: ${policy.causeText}`,
    `영향: ${policy.impactText}`,
    `필요 조치: ${policy.operatorAction}`,
    `주문: PAPER ${input.market} ${input.side} ${input.quantity}`,
    formatPriceLine(input),
    formatCostLine(input),
    optionalLine("잔량", input.remainingQuantity),
    optionalLine("명목 금액", input.requestedNotional),
  ]);
}

function formatPriceLine(input: Pick<PaperTradeAlertInput, "requestedPrice" | "fillPrice">): string | undefined {
  if (input.requestedPrice === undefined && input.fillPrice === undefined) {
    return undefined;
  }

  return joinDefinedLines([
    "가격:",
    input.requestedPrice === undefined ? undefined : `지정가 ${input.requestedPrice}`,
    input.fillPrice === undefined ? undefined : `체결가 ${input.fillPrice}`,
  ], " ");
}

function formatCostLine(
  input: Pick<PaperTradeAlertInput, "feeAmount" | "feeCurrency" | "slippageBps">,
): string | undefined {
  const feeText = input.feeAmount === undefined
    ? undefined
    : `수수료 ${joinDefinedLines([input.feeAmount, input.feeCurrency], " ")}`;
  const slippageText = input.slippageBps === undefined ? undefined : `슬리피지 ${input.slippageBps} bps`;

  if (feeText === undefined && slippageText === undefined) {
    return undefined;
  }

  return joinDefinedLines(["비용:", feeText, slippageText], " ");
}

function optionalLine(label: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${label}: ${value}`;
}

function assignIfDefined(record: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    record[key] = value;
  }
}

function joinDefinedLines(lines: Array<string | undefined>, separator = "\n"): string {
  return lines.filter((line): line is string => line !== undefined && line.length > 0).join(separator);
}
