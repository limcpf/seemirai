import type {
  AlertNotification,
  AlertSeverity,
  DailyReportNotification,
} from "../../application/index.js";
import type { TimestampInput } from "../../domain/index.js";

export const telegramMessageMaxLength = 4_096;
const telegramTruncationSuffix = "\n... [truncated]";
const fingerprintSegmentSeparator = ":";

/**
 * Telegram 운영 알림에서 내부 severity code를 사람이 바로 판단할 수 있는 우선순위 문구로 변환한다.
 *
 * 이 매핑은 저장소와 cooldown key에 쓰는 `P0`~`P3` 값을 바꾸지 않고, outbound message의 첫 줄에서만 의미를 풀어
 * 보여주는 presentation 경계다. 외부 side effect는 없으며, 모든 severity는 반드시 하나의 사용자 표시 문구를 가져야 한다.
 */
const alertSeverityLabels: Record<AlertSeverity, string> = {
  P0: "P0 긴급",
  P1: "P1 중요",
  P2: "P2 주의",
  P3: "P3 참고",
};

/**
 * kill switch state machine의 내부 상태를 운영자가 읽는 거래 가능 상태로 번역한다.
 *
 * 내부 enum은 HTTP control, DB snapshot, audit evidence의 안정적인 식별자이므로 유지하고, Telegram에는 현재 거래 영향이
 * 먼저 보이도록 한국어 라벨만 노출한다. 새 상태가 추가되면 이 표를 함께 갱신해야 raw enum이 사용자 첫 화면에 새지 않는다.
 */
const killSwitchStateLabels: Record<string, string> = {
  NORMAL: "정상 거래 가능",
  NEW_ORDERS_BLOCKED: "신규 주문 중단",
  STRATEGY_PAUSED: "전략 평가 중지",
  HARD_STOP: "거래 불가능",
  MANUAL_REVIEW_REQUIRED: "수동 점검 필요",
};

/**
 * 운영 reason code를 사용자에게 보이는 장애 원인 문구로 변환한다.
 *
 * cooldown, retry, audit 경계는 reason code를 그대로 필요로 하지만 Telegram 수신자는 code보다 조치 판단이 먼저 필요하다.
 * 따라서 formatter에서만 한국어 원인 문구를 붙이고, 추적 정보에는 안정적인 fingerprint를 남겨 감사 경로와 연결한다.
 */
const reasonCodeLabels: Record<string, string> = {
  abnormal_state_operator_review_required: "비정상 상태 수동 점검 필요",
  audit_persistence_failure: "감사 기록 저장 실패",
  db_write_failure: "거래 기록 저장 실패",
  duplicate_order_idempotency_key: "중복 주문 키 감지",
  fill_order_accounting_mismatch: "체결/주문 회계 불일치",
  live_order_api_misuse_detected: "실거래 주문 API 오사용 감지",
  notification_consecutive_failure: "알림 연속 실패",
  notification_failure_threshold_exceeded: "알림 장애 지속",
  order_idempotency_violation: "주문 중복 방지 규칙 위반",
  public_websocket_lag: "실시간 시세 수신 지연",
  quote_freshness_insufficient: "호가 최신성 부족",
  report_generation_repeated_failure: "리포트 생성 반복 실패",
  risk_limit_calculation_unavailable: "리스크 한도 계산 불가",
  stale_market_data: "오래된 시세 데이터 감지",
  transient_external_data_gap: "일시적 외부 데이터 공백",
};

/**
 * reason code별로 Telegram 본문에 먼저 보여줄 사용자 설명이다.
 *
 * title과 원인 라벨만으로는 운영자가 다음 행동을 판단하기 어렵기 때문에, 잘 알려진 원인에는 한 문장 수준의 영향 설명을
 * 제공한다. 원문 body는 보조 정보로 유지해 application layer가 만든 세부 근거를 잃지 않는다.
 */
const reasonCodeDescriptions: Record<string, string> = {
  abnormal_state_operator_review_required: "자동 복구보다 사람 확인이 먼저 필요한 상태가 감지됐습니다.",
  audit_persistence_failure: "감사 기록을 저장하지 못해 이후 복구 판단 근거가 부족할 수 있습니다.",
  db_write_failure: "주문/리스크 증거를 저장하지 못해 거래 상태를 보수적으로 제한했습니다.",
  duplicate_order_idempotency_key: "같은 주문 키가 반복되어 중복 주문 가능성을 차단했습니다.",
  fill_order_accounting_mismatch: "체결 결과와 주문 회계 기록이 맞지 않아 추가 거래를 멈췄습니다.",
  live_order_api_misuse_detected: "paper trading 중 실거래 주문 API 호출 가능성이 감지됐습니다.",
  notification_consecutive_failure: "알림 전송 실패가 반복되어 운영자가 시스템 상태를 직접 확인해야 합니다.",
  notification_failure_threshold_exceeded: "알림 장애가 오래 지속되어 자동 감지만으로는 충분하지 않습니다.",
  order_idempotency_violation: "주문 중복 방지 규칙이 깨져 같은 주문이 두 번 처리될 위험이 있습니다.",
  public_websocket_lag: "실시간 시세 수신 지연이 기준치를 넘었습니다.",
  quote_freshness_insufficient: "주문 판단에 쓰는 호가 정보가 충분히 최신 상태가 아닙니다.",
  report_generation_repeated_failure: "운영 리포트 생성 실패가 반복되어 상태 요약을 신뢰하기 어렵습니다.",
  risk_limit_calculation_unavailable: "리스크 한도를 계산할 수 없어 신규 거래 판단을 보류했습니다.",
  stale_market_data: "오래된 시세 데이터가 감지되어 최신 시장 기준의 주문 판단을 보류했습니다.",
  transient_external_data_gap: "외부 데이터가 일시적으로 비어 있어 신규 주문을 보수적으로 막았습니다.",
};

/**
 * fingerprint에서 사람이 확인할 수 있는 운영 차원을 복원한 값이다.
 *
 * fingerprint는 cooldown key이면서 Telegram 추적 키다. formatter는 이 구조를 best-effort로 읽어 제목과 상세 라벨을 보강하되,
 * fingerprint 자체를 변경하거나 유효성 실패를 전송 실패로 바꾸지 않는다.
 */
interface ParsedAlertFingerprint {
  environment?: string;
  runMode?: string;
  severity?: string;
  alertType?: string;
  market?: string;
  strategyId?: string;
  reasonCode?: string;
}

/**
 * kill switch control alert metadata에서 Telegram 문구에 필요한 action plan만 읽어낸 값이다.
 *
 * metadata는 application port의 JSON 경계라 알 수 없는 값이 섞일 수 있다. formatter는 boolean으로 확인된 필드만 영향 문구로
 * 사용하고, 없는 값은 안전한 기본 안내로 대체한다.
 */
interface UserFacingActionPlan {
  newOrdersBlocked?: boolean;
  strategyEvaluationBlocked?: boolean;
  cancelPendingPaperOrders?: boolean;
  autoLiquidateOpenPositions?: boolean;
  requiresManualReview?: boolean;
}

/**
 * Telegram Bot API의 단일 message text 길이 제한을 전송 전에 강제한다.
 *
 * 운영 장애 alert는 stack trace나 긴 metadata가 붙을 수 있다. provider 400 응답으로 알림 전체가 유실되는 것보다 앞부분의
 * 핵심 문맥과 truncation marker를 보존하는 쪽이 안전하다. 후속 report/attachment 분할은 별도 기능 범위로 둔다.
 */
export function enforceTelegramMessageLimit(
  text: string,
  maxLength: number = telegramMessageMaxLength,
): string {
  const characters = Array.from(text);
  if (characters.length <= maxLength) {
    return text;
  }

  const suffixCharacters = Array.from(telegramTruncationSuffix);
  const headLength = Math.max(0, maxLength - suffixCharacters.length);
  return [...characters.slice(0, headLength), ...suffixCharacters].join("");
}

/**
 * Telegram alert plain text를 만든다.
 *
 * HTML/Markdown parse mode를 쓰지 않아 escaping 오류나 command-like text 해석을 피한다. kill switch control처럼 사용자가 바로
 * 행동해야 하는 알림은 metadata를 읽어 한국어 상태/원인/영향 중심으로 재구성하고, 일반 알림은 fingerprint와 reason code를
 * best-effort로 풀어 제목과 본문을 보강한다. 이 함수는 순수 formatter이며 provider 호출 같은 외부 side effect가 없다.
 */
export function formatAlertMessage(notification: AlertNotification): string {
  const metadata = asRecord(notification.metadata);
  if (metadata !== undefined && readStringField(metadata, "source") === "kill_switch_control") {
    // kill switch 전이는 raw enum보다 현재 거래 영향이 먼저 보여야 운영자가 바로 차단 상태를 이해할 수 있다.
    return formatKillSwitchControlAlertMessage(notification, metadata);
  }

  return formatGenericAlertMessage(notification, metadata);
}

/**
 * Telegram daily report plain text를 만든다.
 *
 * daily report aggregator는 후속 sub PR 범위이므로 여기서는 NotifierPort contract에 맞춘 전송 format만 제공한다. 제목과 추적
 * 라벨은 한국어로 고정해 실제 집계가 붙더라도 Telegram 수신자가 리포트 성격과 생성 시각을 빠르게 구분할 수 있게 한다.
 */
export function formatDailyReportMessage(notification: DailyReportNotification): string {
  return joinMessageLines([
    `[운영 일간 리포트] ${notification.reportDate}`,
    "",
    "요약",
    ...normalizeBodyLines(notification.summary),
    "",
    "추적 정보",
    `생성 시각: ${toIsoTimestamp(notification.generatedAt)}`,
  ]);
}

/**
 * accepted kill switch control 전이를 한국어 운영 메시지로 재구성한다.
 *
 * 이 formatter는 Telegram 수신자에게 "무슨 내부 enum이 발생했는가"보다 "현재 거래가 가능한가, 왜 막혔는가, 무엇을 확인해야
 * 하는가"를 먼저 보여준다. audit/risk id와 fingerprint는 하단 추적 정보로 내려 내부 운영 evidence와의 연결성은 유지한다.
 */
function formatKillSwitchControlAlertMessage(
  notification: AlertNotification,
  metadata: Record<string, unknown>,
): string {
  const parsedFingerprint = parseAlertFingerprint(notification.fingerprint);
  const fromState = readStringField(metadata, "from_state");
  const toState = readStringField(metadata, "to_state");
  const reasonCode = readStringField(metadata, "reason_code") ?? parsedFingerprint.reasonCode;
  const actionPlan = readActionPlan(metadata);
  const targetStateLabel = labelKillSwitchState(toState);
  const previousStateLine = fromState === undefined ? undefined : `이전 상태: ${labelKillSwitchState(fromState)}`;
  const reasonLine = reasonCode === undefined ? undefined : `원인: ${labelReasonCode(reasonCode)}`;
  const impactLines = describeActionPlanImpact(actionPlan, toState);

  return joinMessageLines([
    `[${labelSeverity(notification.severity)}] 거래 상태가 ${targetStateLabel} 상태로 바뀌었습니다`,
    "",
    `현재 상태: ${targetStateLabel}`,
    previousStateLine,
    reasonLine,
    "영향:",
    ...impactLines.map((line) => `- ${line}`),
    `필요 조치: ${recommendOperatorAction(toState, reasonCode)}`,
    "",
    "추적 정보",
    `알림 식별자: ${notification.fingerprint}`,
    `발생 시각: ${toIsoTimestamp(notification.occurredAt)}`,
    optionalLine("요청 ID", readStringField(metadata, "correlation_id")),
    optionalLine("감사 이벤트", readStringField(metadata, "audit_event_id")),
    optionalLine("리스크 이벤트", readStringField(metadata, "risk_event_id")),
    optionalLine("요청자", readStringField(metadata, "actor")),
  ]);
}

/**
 * 특정 도메인 전이가 아닌 일반 alert를 한국어 라벨 중심의 운영 메시지로 만든다.
 *
 * application layer가 넘긴 title/body를 버리지 않되, fingerprint와 metadata에서 reason code를 읽어 사용자 문구를 먼저 배치한다.
 * 알 수 없는 reason은 원문 제목과 본문을 유지해 새 알림 유형이 추가되어도 전송 자체가 깨지지 않는 invariant를 지킨다.
 */
function formatGenericAlertMessage(
  notification: AlertNotification,
  metadata: Record<string, unknown> | undefined,
): string {
  const parsedFingerprint = parseAlertFingerprint(notification.fingerprint);
  const reasonCode = readStringField(metadata, "reason_code") ?? parsedFingerprint.reasonCode;
  const title = titleForGenericAlert(notification.title, parsedFingerprint.alertType, reasonCode);
  const description = reasonCode === undefined ? undefined : reasonCodeDescriptions[reasonCode];
  const bodyLines = normalizeBodyLines(notification.body);
  const bodyDetailLines =
    description === undefined
      ? prefixBodyLines("내용", bodyLines)
      : [
          `내용: ${description}`,
          ...bodyLines
            .filter((line) => line !== description)
            .map((line) => `원문: ${line}`),
        ];

  return joinMessageLines([
    `[${labelSeverity(notification.severity)}] ${title}`,
    "",
    ...bodyDetailLines,
    reasonCode === undefined ? undefined : `원인: ${labelReasonCode(reasonCode)}`,
    optionalLine("마켓", displayOperationalValue(parsedFingerprint.market)),
    optionalLine("전략", displayOperationalValue(parsedFingerprint.strategyId)),
    "",
    "추적 정보",
    `알림 식별자: ${notification.fingerprint}`,
    `발생 시각: ${toIsoTimestamp(notification.occurredAt)}`,
    optionalLine("요청 ID", readStringField(metadata, "correlation_id")),
  ]);
}

function titleForGenericAlert(
  fallbackTitle: string,
  alertType: string | undefined,
  reasonCode: string | undefined,
): string {
  if (reasonCode !== undefined && reasonCodeLabels[reasonCode] !== undefined) {
    return reasonCodeLabels[reasonCode];
  }

  if (alertType !== undefined && reasonCodeLabels[alertType] !== undefined) {
    return reasonCodeLabels[alertType];
  }

  return fallbackTitle;
}

function labelSeverity(severity: AlertSeverity): string {
  return alertSeverityLabels[severity];
}

function labelKillSwitchState(state: string | undefined): string {
  if (state === undefined) {
    return "상태 미확인";
  }

  return killSwitchStateLabels[state] ?? `분류되지 않은 상태 (${state})`;
}

function labelReasonCode(reasonCode: string): string {
  return reasonCodeLabels[reasonCode] ?? `분류되지 않은 사유 (${reasonCode})`;
}

function describeActionPlanImpact(
  actionPlan: UserFacingActionPlan | undefined,
  toState: string | undefined,
): string[] {
  const lines: string[] = [];
  if (actionPlan?.newOrdersBlocked === true) {
    lines.push("신규 주문이 차단됩니다.");
  }
  if (actionPlan?.strategyEvaluationBlocked === true) {
    lines.push("자동 전략 평가가 중단됩니다.");
  }
  if (actionPlan?.cancelPendingPaperOrders === true) {
    lines.push("대기 중인 모의 주문 취소가 예약됩니다.");
  }
  if (actionPlan?.autoLiquidateOpenPositions === true) {
    lines.push("보유 포지션 자동 청산이 예약됩니다.");
  }
  if (toState === "HARD_STOP" && actionPlan?.autoLiquidateOpenPositions === false) {
    lines.push("보유 포지션은 자동 청산하지 않습니다.");
  }
  if (actionPlan?.requiresManualReview === true) {
    lines.push("수동 점검 전까지 복구를 보류합니다.");
  }

  if (lines.length > 0) {
    return lines;
  }

  switch (toState) {
    case "NEW_ORDERS_BLOCKED":
      return ["신규 주문을 멈추고 관측과 복구를 기다립니다."];
    case "STRATEGY_PAUSED":
      return ["전략 평가를 멈추고 기존 전역 거래 상태는 별도로 판단합니다."];
    case "MANUAL_REVIEW_REQUIRED":
      return ["자동 복구 대신 운영자 점검을 기다립니다."];
    case "HARD_STOP":
      return ["신규 주문과 자동 전략 판단을 모두 멈춥니다."];
    default:
      return ["거래 제한 상태가 변경됐습니다."];
  }
}

function recommendOperatorAction(
  toState: string | undefined,
  reasonCode: string | undefined,
): string {
  if (reasonCode === "db_write_failure" || reasonCode === "audit_persistence_failure") {
    return "DB 상태와 최근 감사/리스크 이벤트 저장 여부를 확인해 주세요.";
  }
  if (reasonCode === "public_websocket_lag" || reasonCode === "stale_market_data") {
    return "시세 수신 상태와 데이터 최신성을 확인하고, 회복 전까지 신규 주문 차단을 유지해 주세요.";
  }
  if (reasonCode === "notification_consecutive_failure" || reasonCode === "notification_failure_threshold_exceeded") {
    return "알림 채널 상태와 최근 장애 이벤트를 확인한 뒤 복구 여부를 판단해 주세요.";
  }

  switch (toState) {
    case "HARD_STOP":
      return "DB 상태, 감사/리스크 이벤트, 대기 주문 취소 job을 확인해 주세요.";
    case "NEW_ORDERS_BLOCKED":
      return "시장 데이터가 충분히 최신인지 확인한 뒤 신규 주문 재개 여부를 판단해 주세요.";
    case "MANUAL_REVIEW_REQUIRED":
      return "최근 장애 이벤트를 확인하고 수동 점검 후 복구 경로를 선택해 주세요.";
    case "STRATEGY_PAUSED":
      return "전략별 상태와 최근 리스크 이벤트를 확인해 주세요.";
    default:
      return "최근 감사/리스크 이벤트를 확인하고 필요한 차단 상태를 유지해 주세요.";
  }
}

function readActionPlan(metadata: Record<string, unknown>): UserFacingActionPlan | undefined {
  const actionPlan = asRecord(metadata.action_plan);
  if (actionPlan === undefined) {
    return undefined;
  }

  return {
    ...optionalBooleanProperty("newOrdersBlocked", readBooleanField(actionPlan, "new_orders_blocked")),
    ...optionalBooleanProperty(
      "strategyEvaluationBlocked",
      readBooleanField(actionPlan, "strategy_evaluation_blocked"),
    ),
    ...optionalBooleanProperty(
      "cancelPendingPaperOrders",
      readBooleanField(actionPlan, "cancel_pending_paper_orders"),
    ),
    ...optionalBooleanProperty(
      "autoLiquidateOpenPositions",
      readBooleanField(actionPlan, "auto_liquidate_open_positions"),
    ),
    ...optionalBooleanProperty("requiresManualReview", readBooleanField(actionPlan, "requires_manual_review")),
  };
}

function parseAlertFingerprint(fingerprint: string): ParsedAlertFingerprint {
  const parts = fingerprint.split(fingerprintSegmentSeparator);
  if (parts[0] !== "alert") {
    return {};
  }

  const [
    ,
    environment,
    runMode,
    severity,
    alertType,
    market,
    strategyId,
    reasonCode,
  ] = parts;

  return {
    ...optionalStringProperty("environment", decodeFingerprintPart(environment)),
    ...optionalStringProperty("runMode", decodeFingerprintPart(runMode)),
    ...optionalStringProperty("severity", severity),
    ...optionalStringProperty("alertType", decodeFingerprintPart(alertType)),
    ...optionalStringProperty("market", decodeFingerprintPart(market)),
    ...optionalStringProperty("strategyId", decodeFingerprintPart(strategyId)),
    ...optionalStringProperty("reasonCode", decodeFingerprintPart(reasonCode)),
  };
}

function decodeFingerprintPart(value: string | undefined): string | undefined {
  return value?.replaceAll("%3a", ":");
}

function displayOperationalValue(value: string | undefined): string | undefined {
  if (value === undefined || value === "global") {
    return undefined;
  }

  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringProperty<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function optionalBooleanProperty<Key extends string>(
  key: Key,
  value: boolean | undefined,
): Partial<Record<Key, boolean>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, boolean>;
}

function optionalLine(label: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${label}: ${value}`;
}

function prefixBodyLines(label: string, bodyLines: string[]): string[] {
  if (bodyLines.length === 0) {
    return [];
  }

  const [firstLine, ...rest] = bodyLines;
  return [`${label}: ${firstLine}`, ...rest];
}

function normalizeBodyLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function joinMessageLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function toIsoTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}
