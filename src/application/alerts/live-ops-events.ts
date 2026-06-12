import type { AlertSeverity } from "../ports/index.js";
import type { JsonRecord, OrderSide, TimestampInput } from "../../domain/index.js";
import type { AlertDispatchRequest } from "./index.js";

export const liveOpsAlertSource = "live_ops_event";
export const liveOpsAlertType = "live_ops_event";

/**
 * M23 live 운영 알림이 다루는 lifecycle와 trade event 목록이다.
 *
 * 이 값은 runtime, reconcile, broker 경계에서 확정된 안전한 evidence를 Telegram alert 후보로 낮출 때 쓰는 입력 contract다.
 * mapper는 event를 한국어 상태/원인/영향/필요 조치와 cooldown/retry key로 정규화하지만, 주문 상태 변경, DB write, Telegram
 * provider 호출 같은 외부 side effect는 수행하지 않는다. 새 event를 추가하면 severity, reason code, 사용자 문구, formatter
 * 추적 정보 배치를 함께 고정해야 한다.
 */
export type LiveOpsAlertEventKind =
  | "TELEGRAM_CONNECTION_READY"
  | "LIVE_ORDER_CAPABLE_STARTED"
  | "NORMAL_SHUTDOWN"
  | "OPERATOR_STOP"
  | "KILL_SWITCH_STOP"
  | "MANUAL_REVIEW_REQUIRED"
  | "CRASH_DETECTED"
  | "RESTART_DETECTED"
  | "RECOVERY_COMPLETED"
  | "TELEGRAM_PROVIDER_FAILURE_SUSTAINED"
  | "ORDER_SUBMITTED"
  | "CANCEL_REQUESTED"
  | "CANCEL_CONFIRMED"
  | "ORDER_FILLED"
  | "ORDER_PARTIALLY_FILLED"
  | "RISK_BLOCKED"
  | "COST_BLOCKED"
  | "RECONCILE_BLOCKED";

/**
 * M23 live alert가 속한 운영 event 분류다.
 *
 * lifecycle event는 runtime 연결, arm, 중지, 재시작, 복구 상태를 설명하고, trade event는 주문/취소/체결/차단 evidence를
 * 설명한다. 이 분류는 Telegram 본문과 audit metadata의 문맥용 값이며, broker 호출이나 retry 동작을 직접 바꾸지 않는다.
 */
export type LiveOpsAlertEventGroup = "lifecycle" | "trade";

/**
 * M23 live alert의 전송 정책 분류다.
 *
 * `immediate`는 P0/P1 retry 후보가 될 수 있는 운영 개입 알림이고, `cooldown`은 P2 lifecycle 소음 억제 알림이다. 실제 중복
 * 억제와 provider retry는 `dispatchAlertWithCooldown`이 severity와 fingerprint 기준으로 수행한다.
 */
export type LiveOpsAlertDeliveryPolicy = "immediate" | "cooldown";

/**
 * M23 lifecycle/trade evidence를 alert dispatch 요청으로 바꾸기 위한 입력이다.
 *
 * caller는 DB commit, broker 응답, runtime lifecycle 판단이 확정된 뒤 이 구조를 만든다. 주문·취소·체결 식별자는 첫 화면에
 * 직접 노출하지 않고 `추적 정보`로 내려가며, `safeSummary`와 `safeDetails`에는 Telegram token, raw provider body, raw update,
 * credential, 원문 주문 payload를 넣지 않아야 한다. 이 입력은 알림 후보 생성 경계일 뿐 외부 API 호출이나 DB write side effect를
 * 만들지 않는다.
 */
export interface LiveOpsAlertInput {
  environment: string;
  runMode: string;
  eventKind: LiveOpsAlertEventKind;
  occurredAt?: TimestampInput;
  correlationId?: string;
  market?: string;
  strategyId?: string;
  operatingMode?: string;
  liveOrderCapable?: boolean;
  side?: OrderSide;
  quantity?: string;
  requestedPrice?: string;
  fillPrice?: string;
  filledQuantity?: string;
  remainingQuantity?: string;
  notionalKrw?: string;
  feeAmount?: string;
  feeCurrency?: string;
  slippageBps?: string;
  orderId?: string;
  brokerOrderId?: string;
  idempotencyKey?: string;
  auditEventId?: string;
  riskEventId?: string;
  evidenceId?: string;
  restartId?: string;
  /**
   * 사용자에게 보여줄 안전한 차단 사유다.
   *
   * 내부 reason code가 아니라 운영자가 바로 이해할 수 있는 문장을 넣어야 하며, stable code는 `safeDetails`나 event evidence에
   * 보존한다. formatter는 이 값을 첫 화면에 표시하므로 raw provider body나 credential을 넣지 않는다.
   */
  blockedReason?: string;
  safeSummary?: string;
  safeDetails?: JsonRecord;
}

/**
 * M23 live alert event별 고정 정책이다.
 *
 * reason code는 fingerprint와 retry/audit payload에 쓰는 안정 식별자이며, status/cause/impact/action은 Telegram 첫 화면의
 * 사용자 행동 언어다. 정책은 순수 데이터라 provider 호출, cooldown 기록, audit write side effect를 만들지 않는다.
 */
interface LiveOpsAlertPolicy {
  severity: AlertSeverity;
  group: LiveOpsAlertEventGroup;
  deliveryPolicy: LiveOpsAlertDeliveryPolicy;
  reasonCode: string;
  eventLabel: string;
  statusText: string;
  causeText: string;
  impactText: string;
  operatorAction: string;
}

const liveOpsAlertPolicies: Record<LiveOpsAlertEventKind, LiveOpsAlertPolicy> = {
  TELEGRAM_CONNECTION_READY: {
    severity: "P2",
    group: "lifecycle",
    deliveryPolicy: "cooldown",
    reasonCode: "telegram_connection_ready",
    eventLabel: "Telegram 연결 확인",
    statusText: "Telegram 운영 알림 채널이 연결됐습니다.",
    causeText: "런타임이 owner chat으로 outbound sendMessage를 보낼 수 있는 설정을 확인했습니다.",
    impactText: "이후 lifecycle, 주문, 차단, 복구 알림을 같은 채널에서 받을 수 있습니다.",
    operatorAction: "첫 알림 수신 시각과 owner chat이 의도한 운영 채널인지 확인해 주세요.",
  },
  LIVE_ORDER_CAPABLE_STARTED: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_capable_started",
    eventLabel: "실주문 가능 시작",
    statusText: "M23 live small-budget runtime이 실주문 가능 상태로 전환됐습니다.",
    causeText: "live 설정, key scope, heartbeat, reconcile, kill switch 조건이 주문 가능 기준을 통과했습니다.",
    impactText: "전략 후보가 비용과 리스크 게이트를 통과하면 실제 Upbit 주문 API 호출이 가능해집니다.",
    operatorAction: "손실 ceiling, open exposure, 최신 reconcile 시각을 확인하고 운영 감시를 유지해 주세요.",
  },
  NORMAL_SHUTDOWN: {
    severity: "P2",
    group: "lifecycle",
    deliveryPolicy: "cooldown",
    reasonCode: "live_ops_normal_shutdown",
    eventLabel: "정상 종료",
    statusText: "M23 live runtime이 정상 종료 절차를 시작했습니다.",
    causeText: "프로세스가 종료 신호를 받고 마지막 event/report 정리를 수행했습니다.",
    impactText: "신규 주문 판단은 중단되며 open order와 open exposure는 reconcile 확인 대상입니다.",
    operatorAction: "마지막 summary/report artifact와 status reconcile 결과를 확인해 주세요.",
  },
  OPERATOR_STOP: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_operator_stop",
    eventLabel: "운영자 중지",
    statusText: "운영자 요청으로 M23 live runtime 중지 절차가 실행됐습니다.",
    causeText: "수동 stop 또는 pause/kill control이 신규 entry를 보수적으로 차단했습니다.",
    impactText: "자동 신규 주문은 멈추며 미체결 주문은 status와 Upbit read-only 조회로 확인해야 합니다.",
    operatorAction: "신규 entry 차단 evidence와 미체결 주문 상태를 확인해 주세요.",
  },
  KILL_SWITCH_STOP: {
    severity: "P0",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_kill_switch_stop",
    eventLabel: "Kill switch 중지",
    statusText: "Kill switch 때문에 M23 live runtime이 거래 차단 상태로 전환됐습니다.",
    causeText: "거래 안전 invariant가 깨질 수 있는 조건이 감지되어 신규 주문을 fail-closed 처리했습니다.",
    impactText: "자동 복구 전까지 신규 주문이 차단되고 manual review 또는 별도 복구 절차가 필요합니다.",
    operatorAction: "risk/audit evidence와 pending cancel 필요 여부를 확인하고 수동 복구 경로를 선택해 주세요.",
  },
  MANUAL_REVIEW_REQUIRED: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_manual_review_required",
    eventLabel: "수동 점검 필요",
    statusText: "M23 live runtime이 수동 점검 필요 상태로 전환됐습니다.",
    causeText: "자동 판단만으로 안전하게 복구하기 어려운 상태가 감지됐습니다.",
    impactText: "운영자 확인 전까지 live order capable 상태로 보지 않습니다.",
    operatorAction: "최근 decision, risk, reconcile, alert retry evidence를 같은 correlation id로 대조해 주세요.",
  },
  CRASH_DETECTED: {
    severity: "P0",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_crash_detected",
    eventLabel: "Crash 감지",
    statusText: "M23 live runtime crash 또는 비정상 종료가 감지됐습니다.",
    causeText: "프로세스가 정상 shutdown evidence 없이 종료됐거나 supervisor가 비정상 종료를 보고했습니다.",
    impactText: "재시작 전후 duplicate live order, reconcile mismatch, untracked fill 여부를 확인해야 합니다.",
    operatorAction: "재시작 직후 status, reconcile, open order, latest heartbeat를 확인해 주세요.",
  },
  RESTART_DETECTED: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_restart_detected",
    eventLabel: "재시작 감지",
    statusText: "M23 live runtime 재시작이 감지됐습니다.",
    causeText: "supervisor 또는 운영자가 프로세스를 다시 시작해 durable 상태 복구가 필요합니다.",
    impactText: "기존 idempotency key와 order attempt가 duplicate live order로 이어지지 않아야 합니다.",
    operatorAction: "복구 직후 reconcile/status가 같은 주문 경계를 재사용하는지 확인해 주세요.",
  },
  RECOVERY_COMPLETED: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "live_ops_recovery_completed",
    eventLabel: "복구 확인",
    statusText: "M23 live runtime 복구 확인이 완료됐습니다.",
    causeText: "재시작 후 heartbeat, reconcile, status summary가 다시 관측 가능한 상태로 돌아왔습니다.",
    impactText: "운영자는 duplicate order와 reconcile mismatch가 없는지 closeout evidence로 확인할 수 있습니다.",
    operatorAction: "재시작 전후 order attempt, reconcile snapshot, daily report 연결성을 확인해 주세요.",
  },
  TELEGRAM_PROVIDER_FAILURE_SUSTAINED: {
    severity: "P1",
    group: "lifecycle",
    deliveryPolicy: "immediate",
    reasonCode: "telegram_provider_failure_sustained",
    eventLabel: "Telegram 장애 지속",
    statusText: "Telegram 알림 전송 장애가 지속되고 있습니다.",
    causeText: "provider timeout, HTTP 오류, API 오류가 반복되어 운영자가 알림만으로 상태를 신뢰하기 어렵습니다.",
    impactText: "P0/P1 alert retry와 manual review 수렴 상태를 직접 확인해야 합니다.",
    operatorAction: "알림 설정, provider 상태, notification retry job, `/status.alerts`를 확인해 주세요.",
  },
  ORDER_SUBMITTED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_submitted",
    eventLabel: "주문 제출",
    statusText: "M23 live 주문이 거래소 제출 경계로 전진했습니다.",
    causeText: "후보가 비용 모델, 리스크 게이트, idempotency reservation을 통과했습니다.",
    impactText: "실제 주문 API가 호출됐으므로 체결, 취소, reconcile 결과를 이어서 확인해야 합니다.",
    operatorAction: "주문 키, 거래소 주문 ID, open exposure가 예상 범위인지 확인해 주세요.",
  },
  CANCEL_REQUESTED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_cancel_requested",
    eventLabel: "취소 요청",
    statusText: "M23 live 주문 취소 요청이 접수됐습니다.",
    causeText: "정책화된 cleanup 또는 운영 중지 절차가 미체결 주문 취소를 요청했습니다.",
    impactText: "취소 요청은 최종 취소 확인이 아니므로 후속 terminal 상태 확인이 필요합니다.",
    operatorAction: "취소 확인 알림이나 reconcile에서 주문 상태가 cancel/done으로 닫혔는지 확인해 주세요.",
  },
  CANCEL_CONFIRMED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_cancel_confirmed",
    eventLabel: "취소 확인",
    statusText: "M23 live 주문 취소가 terminal 상태로 확인됐습니다.",
    causeText: "거래소 조회 또는 reconcile이 주문 취소 완료 상태를 확인했습니다.",
    impactText: "취소된 잔량은 open exposure에 남지 않아야 합니다.",
    operatorAction: "open order 수와 open exposure가 0 또는 예상 범위로 줄었는지 확인해 주세요.",
  },
  ORDER_FILLED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_filled",
    eventLabel: "전체 체결",
    statusText: "M23 live 주문이 전체 체결됐습니다.",
    causeText: "거래소 체결 또는 reconcile이 주문 잔량 0 상태를 확인했습니다.",
    impactText: "포지션, 수수료, realized/unrealized PnL이 daily report와 budget surface에 반영되어야 합니다.",
    operatorAction: "체결가, 수수료, open exposure, PnL snapshot이 기대 범위인지 확인해 주세요.",
  },
  ORDER_PARTIALLY_FILLED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_partially_filled",
    eventLabel: "부분 체결",
    statusText: "M23 live 주문 일부가 체결됐습니다.",
    causeText: "거래소 체결 또는 reconcile이 주문 잔량 일부를 아직 열려 있는 상태로 관측했습니다.",
    impactText: "잔량은 취소, 추가 체결, manual review 중 하나로 수렴해야 합니다.",
    operatorAction: "잔량, open exposure, 후속 취소/체결 evidence를 확인해 주세요.",
  },
  RISK_BLOCKED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_risk_blocked",
    eventLabel: "리스크 차단",
    statusText: "M23 live 주문 후보가 리스크 게이트에서 차단됐습니다.",
    causeText: "계정, 손실, 노출, kill switch, 데이터 최신성 조건 중 하나가 주문 허용 기준을 통과하지 못했습니다.",
    impactText: "신규 주문은 제출되지 않으며 차단 사유는 decision/risk evidence와 daily report에 남아야 합니다.",
    operatorAction: "차단 사유가 반복되면 한도, kill switch 상태, market data 최신성을 확인해 주세요.",
  },
  COST_BLOCKED: {
    severity: "P2",
    group: "trade",
    deliveryPolicy: "cooldown",
    reasonCode: "live_order_cost_blocked",
    eventLabel: "비용 차단",
    statusText: "M23 live 주문 후보가 비용 모델에서 차단됐습니다.",
    causeText: "수수료, spread, slippage, 기대값 조건이 주문 허용 기준을 통과하지 못했습니다.",
    impactText: "실제 주문은 제출되지 않고 주문 없음 이유가 decision evidence에 남습니다.",
    operatorAction: "시장 조건 미충족이 반복되는지 daily report의 후보 없음/차단 사유와 비교해 주세요.",
  },
  RECONCILE_BLOCKED: {
    severity: "P1",
    group: "trade",
    deliveryPolicy: "immediate",
    reasonCode: "live_order_reconcile_blocked",
    eventLabel: "Reconcile 차단",
    statusText: "M23 live 주문 후보가 reconcile 조건 때문에 차단됐습니다.",
    causeText: "미체결 주문, 계정 상태, 로컬/거래소 주문 대조가 주문 가능 기준을 만족하지 못했습니다.",
    impactText: "중복 주문이나 untracked fill을 막기 위해 신규 entry를 fail-closed 처리합니다.",
    operatorAction: "reconcile snapshot, open order, unmatched fill evidence를 확인해 주세요.",
  },
};

/**
 * M23 lifecycle/trade event evidence를 alert dispatch 요청으로 변환한다.
 *
 * 반환값은 `dispatchAlertWithCooldown`에 그대로 넘길 수 있는 순수 데이터다. mapper는 연결 성공과 실주문 가능 시작을 서로 다른
 * reason/fingerprint로 분리하고, trade event는 주문/취소/체결/차단 상태를 한국어 첫 화면 문구와 `추적 정보` metadata로 나눠
 * 보존한다. provider 실패, retry job 예약, cooldown 판단은 alert dispatch 계층 책임이며, 이 함수 자체는 외부 side effect가 없다.
 *
 * @param input M23 lifecycle 또는 trade event의 secret-safe evidence
 * @returns cooldown/retry dispatch가 사용할 alert 요청
 */
export function createLiveOpsAlertRequest(input: LiveOpsAlertInput): AlertDispatchRequest {
  const policy = liveOpsAlertPolicies[input.eventKind];
  const dedupeKey = resolveLiveOpsAlertDedupeKey(input, policy);

  return {
    environment: input.environment,
    runMode: input.runMode,
    severity: policy.severity,
    alertType: liveOpsAlertType,
    ...(input.market === undefined ? {} : { market: input.market }),
    ...(input.strategyId === undefined ? {} : { strategyId: input.strategyId }),
    reasonCode: policy.reasonCode,
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
    title: `M23 live 운영 알림: ${policy.eventLabel}`,
    body: formatLiveOpsAlertBody(input, policy),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    metadata: createLiveOpsAlertMetadata(input, policy),
  };
}

/**
 * M23 live trade alert가 실제 주문/체결/차단 evidence 단위로 dedupe되도록 업무 식별자를 고른다.
 *
 * lifecycle alert는 상태 변화 단위 cooldown을 유지해야 하므로 기본적으로 별도 key를 붙이지 않는다. 다만 수동 점검은 서로 다른
 * 복구 지시가 같은 cooldown에 묶이면 위험하므로 caller가 evidence/correlation을 제공한 경우 그 값을 사용한다. trade alert는
 * 같은 market/strategy에서 5분 안에 여러 주문 또는 체결이 생겨도 서로 다른 Telegram 알림으로 남아야 한다. 부분/전체 체결은
 * 같은 주문 키를 공유할 수 있으므로 체결 evidence ID를 먼저 쓰고, 차단 이벤트는 주문 ID가 없을 수 있으므로 risk/audit evidence를
 * 포함한다. 이 함수는 순수 선택 로직이며 외부 side effect가 없다.
 */
function resolveLiveOpsAlertDedupeKey(
  input: LiveOpsAlertInput,
  policy: LiveOpsAlertPolicy,
): string | undefined {
  if (input.eventKind === "MANUAL_REVIEW_REQUIRED") {
    return input.evidenceId
      ?? input.auditEventId
      ?? input.riskEventId
      ?? input.correlationId;
  }

  if (policy.group !== "trade") {
    return undefined;
  }

  if (input.eventKind === "ORDER_FILLED" || input.eventKind === "ORDER_PARTIALLY_FILLED") {
    return input.evidenceId
      ?? input.brokerOrderId
      ?? input.orderId
      ?? input.idempotencyKey
      ?? input.correlationId;
  }

  if (input.eventKind === "RISK_BLOCKED" || input.eventKind === "COST_BLOCKED" || input.eventKind === "RECONCILE_BLOCKED") {
    return input.evidenceId
      ?? input.riskEventId
      ?? input.auditEventId
      ?? input.correlationId;
  }

  return input.idempotencyKey
    ?? input.orderId
    ?? input.brokerOrderId
    ?? input.evidenceId
    ?? input.riskEventId
    ?? input.auditEventId
    ?? input.correlationId;
}

/**
 * Telegram formatter와 audit payload가 공유할 M23 live alert metadata를 만든다.
 *
 * metadata에는 stable code와 내부 식별자를 보존하되, 사용자 첫 화면에 필요한 문구는 별도 필드로 같이 넣어 formatter가 raw enum을
 * 노출하지 않게 한다. 입력의 `safeDetails`는 이미 secret-safe여야 하며 이 함수는 provider body를 검사하거나 저장하지 않는다.
 */
function createLiveOpsAlertMetadata(
  input: LiveOpsAlertInput,
  policy: LiveOpsAlertPolicy,
): JsonRecord {
  const metadata: JsonRecord = {
    source: liveOpsAlertSource,
    event_kind: input.eventKind,
    event_group: policy.group,
    event_label: policy.eventLabel,
    delivery_policy: policy.deliveryPolicy,
    reason_code: policy.reasonCode,
    status_text: policy.statusText,
    cause_text: policy.causeText,
    impact_text: policy.impactText,
    operator_action: policy.operatorAction,
  };

  // 내부 식별자와 code는 첫 화면 대신 추적 정보로 내려 운영 evidence 연결성을 보존한다.
  assignIfDefined(metadata, "market", input.market);
  assignIfDefined(metadata, "strategy_id", input.strategyId);
  assignIfDefined(metadata, "operating_mode", input.operatingMode);
  assignIfDefined(metadata, "live_order_capable", input.liveOrderCapable);
  assignIfDefined(metadata, "side", input.side);
  assignIfDefined(metadata, "quantity", input.quantity);
  assignIfDefined(metadata, "requested_price", input.requestedPrice);
  assignIfDefined(metadata, "fill_price", input.fillPrice);
  assignIfDefined(metadata, "filled_quantity", input.filledQuantity);
  assignIfDefined(metadata, "remaining_quantity", input.remainingQuantity);
  assignIfDefined(metadata, "notional_krw", input.notionalKrw);
  assignIfDefined(metadata, "fee_amount", input.feeAmount);
  assignIfDefined(metadata, "fee_currency", input.feeCurrency);
  assignIfDefined(metadata, "slippage_bps", input.slippageBps);
  assignIfDefined(metadata, "order_id", input.orderId);
  assignIfDefined(metadata, "broker_order_id", input.brokerOrderId);
  assignIfDefined(metadata, "idempotency_key", input.idempotencyKey);
  assignIfDefined(metadata, "correlation_id", input.correlationId);
  assignIfDefined(metadata, "audit_event_id", input.auditEventId);
  assignIfDefined(metadata, "risk_event_id", input.riskEventId);
  assignIfDefined(metadata, "evidence_id", input.evidenceId);
  assignIfDefined(metadata, "restart_id", input.restartId);
  assignIfDefined(metadata, "blocked_reason", input.blockedReason);
  assignIfDefined(metadata, "safe_summary", input.safeSummary);
  assignIfDefined(metadata, "safe_details", input.safeDetails);

  return metadata;
}

/**
 * M23 live alert의 첫 화면 본문을 한국어 상태/원인/영향/필요 조치 순서로 만든다.
 *
 * 주문 식별자, reason code, evidence id는 metadata로 분리하고, 본문에는 운영자가 즉시 판단해야 하는 상태와 주문 규모/가격/잔량만
 * 선택적으로 배치한다. 이 함수는 문자열 조합만 수행하며 Telegram 전송이나 cooldown 저장 side effect가 없다.
 */
function formatLiveOpsAlertBody(
  input: LiveOpsAlertInput,
  policy: LiveOpsAlertPolicy,
): string {
  return joinDefinedLines([
    `상태: ${policy.statusText}`,
    `원인: ${policy.causeText}`,
    `영향: ${policy.impactText}`,
    `필요 조치: ${policy.operatorAction}`,
    formatModeLine(input),
    formatLiveOrderLine(input),
    formatLivePriceLine(input),
    formatLiveCostLine(input),
    optionalLine("잔량", input.remainingQuantity),
    optionalLine("요약", input.safeSummary),
  ]);
}

/**
 * 운영 mode를 첫 화면에 노출할 때 raw runtime enum 대신 사용자 행동 언어를 만든다.
 */
function formatModeLine(input: Pick<LiveOpsAlertInput, "operatingMode" | "liveOrderCapable">): string | undefined {
  if (input.operatingMode === undefined && input.liveOrderCapable === undefined) {
    return undefined;
  }

  const capableText = input.liveOrderCapable === undefined
    ? undefined
    : `주문 가능 ${input.liveOrderCapable ? "예" : "아니오"}`;
  return joinDefinedLines([
    "M23 상태:",
    input.operatingMode === undefined ? undefined : labelLiveOpsMode(input.operatingMode),
    capableText,
  ], " ");
}

/**
 * 주문 관련 필드가 모두 있을 때만 사용자-facing 주문 요약 줄을 만든다.
 */
function formatLiveOrderLine(
  input: Pick<LiveOpsAlertInput, "market" | "side" | "quantity">,
): string | undefined {
  if (input.market === undefined || input.side === undefined || input.quantity === undefined) {
    return undefined;
  }

  return `주문: ${input.market} ${labelLiveOrderSide(input.side)} ${input.quantity}`;
}

/**
 * 주문 가격/체결가를 한 줄 요약으로 만든다.
 */
function formatLivePriceLine(
  input: Pick<LiveOpsAlertInput, "requestedPrice" | "fillPrice" | "filledQuantity">,
): string | undefined {
  if (input.requestedPrice === undefined && input.fillPrice === undefined && input.filledQuantity === undefined) {
    return undefined;
  }

  return joinDefinedLines([
    "가격:",
    input.requestedPrice === undefined ? undefined : `지정가 ${input.requestedPrice}`,
    input.fillPrice === undefined ? undefined : `체결가 ${input.fillPrice}`,
    input.filledQuantity === undefined ? undefined : `체결 수량 ${input.filledQuantity}`,
  ], " ");
}

/**
 * 비용/명목금액을 한 줄 요약으로 만든다.
 */
function formatLiveCostLine(
  input: Pick<LiveOpsAlertInput, "notionalKrw" | "feeAmount" | "feeCurrency" | "slippageBps">,
): string | undefined {
  const notionalText = input.notionalKrw === undefined ? undefined : `명목 금액 ${input.notionalKrw} KRW`;
  const feeText = input.feeAmount === undefined
    ? undefined
    : `수수료 ${joinDefinedLines([input.feeAmount, input.feeCurrency], " ")}`;
  const slippageText = input.slippageBps === undefined ? undefined : `슬리피지 ${input.slippageBps} bps`;

  if (notionalText === undefined && feeText === undefined && slippageText === undefined) {
    return undefined;
  }

  return joinDefinedLines(["비용:", notionalText, feeText, slippageText], " ");
}

/**
 * 내부 mode code를 운영자가 읽는 상태 라벨로 낮춘다.
 */
function labelLiveOpsMode(mode: string): string {
  switch (mode) {
    case "live_order_capable":
    case "LIVE_ORDER_CAPABLE":
      return "실주문 가능";
    case "live_armed":
    case "LIVE_ARMED":
    case "LIVE_AUTONOMOUS_SMALL_BUDGET":
      return "실주문 준비";
    case "heartbeat_only":
    case "HEARTBEAT_ONLY":
      return "상태 관측 전용";
    case "dry_run":
    case "DRY_RUN":
    case "PAPER_NO_KEY":
      return "모의 운영";
    default:
      return mode;
  }
}

/**
 * 주문 방향 code를 한국어 행동 라벨과 함께 보여준다.
 */
function labelLiveOrderSide(side: OrderSide): string {
  switch (side) {
    case "BUY":
      return "매수(BUY)";
    case "SELL":
      return "매도(SELL)";
  }
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
