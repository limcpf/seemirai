import type {
  AlertNotification,
  AlertSeverity,
  AuditLogPort,
  NotificationResult,
  NotifierPort,
} from "../ports/index.js";
import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export const notificationRetryJobType = "notification_retry";
export const defaultAlertDeliveryReservationMs = 60_000;

/**
 * alert fingerprint를 구성하는 운영 차원이다.
 *
 * 같은 장애라도 환경, 실행 모드, 심각도, 마켓, 전략, 원인 코드가 다르면 다른 운영 이벤트로 취급한다. 특히 severity를
 * fingerprint에 포함해 낮은 등급 cooldown이 P0 escalation을 막지 못하게 한다.
 */
export interface AlertFingerprintInput {
  environment: string;
  runMode: string;
  severity: AlertSeverity;
  alertType: string;
  market?: string;
  strategyId?: string;
  reasonCode: string;
}

/**
 * alert dispatch service가 받는 단건 알림 요청이다.
 *
 * request는 provider 전송 payload와 cooldown/audit 판단 근거를 함께 담는다. correlationId는 기존 HTTP control 또는
 * RiskGate 흐름과 운영 이벤트를 이어 보기 위한 선택 필드다.
 */
export interface AlertDispatchRequest extends AlertFingerprintInput {
  title: string;
  body: string;
  occurredAt?: TimestampInput;
  correlationId?: string;
  metadata?: JsonRecord;
}

/**
 * cooldown store에서 조회되는 현재 alert 억제 상태다.
 *
 * lastSentAt은 provider 전송 성공 기준점이고, lastSkippedAt은 cooldown으로 억제된 시각이다. 둘을 분리해 운영자가
 * "실제로 보낸 알림"과 "폭주 방지를 위해 막은 알림"을 감사 로그와 함께 구분할 수 있게 한다. deliveryReservedUntil은
 * provider 호출 전 check-and-set으로 잡는 짧은 lease라 동시 요청이 provider를 중복 호출하지 못하게 한다.
 */
export interface AlertCooldownState {
  fingerprint: string;
  severity: AlertSeverity;
  alertType: string;
  market: string | null;
  strategyId: string | null;
  reasonCode: string;
  lastSentAt: TimestampInput | null;
  lastSkippedAt: TimestampInput | null;
  deliveryReservedUntil: TimestampInput | null;
  payloadJson: JsonRecord;
}

/**
 * cooldown store에 기록할 alert 상태 변경 입력이다.
 *
 * application service가 fingerprint와 normalized business key를 만든 뒤 repository에 넘긴다. repository는 이 값을 그대로
 * durable row 또는 memory state로 반영하고, provider token 같은 secret은 payloadJson에 넣지 않는다.
 */
export interface AlertCooldownRecordInput {
  fingerprint: string;
  severity: AlertSeverity;
  alertType: string;
  market: string | null;
  strategyId: string | null;
  reasonCode: string;
  occurredAt: TimestampInput;
  payloadJson?: JsonRecord;
}

/**
 * provider 호출 전에 fingerprint 단위 전송권을 예약하기 위한 입력이다.
 *
 * cooldownMs는 마지막 성공 전송 기준 중복 억제 창이고, reserveUntil은 provider 호출 경합을 막기 위한 lease 만료 시각이다.
 * repository 구현은 이 두 조건을 하나의 atomic write 조건으로 평가해야 한다.
 */
export interface AlertCooldownReservationInput extends AlertCooldownRecordInput {
  cooldownMs: number;
  reserveUntil: TimestampInput;
}

/**
 * alert delivery reservation 결과다.
 *
 * reserved=false면 이미 cooldown 또는 in-flight reservation이 있다는 뜻이며, state를 기준으로 skip 이유와 만료 시각을
 * 계산한다.
 */
export interface AlertCooldownReservationResult {
  reserved: boolean;
  state: AlertCooldownState;
}

/**
 * alert cooldown state를 저장하는 application port다.
 *
 * P0/P1은 프로세스 재시작 후에도 중복 전송을 막아야 하므로 PostgreSQL 구현을 사용하고, P2/P3은 memory 구현으로 시작한다.
 * application service는 이 port만 호출해 cooldown 저장 방식과 DB transaction 세부사항에 직접 의존하지 않는다.
 */
export interface AlertCooldownStore {
  findByFingerprint(fingerprint: string): Promise<AlertCooldownState | undefined>;
  reserveDelivery(input: AlertCooldownReservationInput): Promise<AlertCooldownReservationResult>;
  recordSent(input: AlertCooldownRecordInput): Promise<AlertCooldownState>;
  recordSkipped(input: AlertCooldownRecordInput): Promise<AlertCooldownState>;
}

/**
 * notification provider 실패 후 retry worker에 넘길 수 있는 작업 계획이다.
 *
 * Sub PR 3은 jobs table insert를 직접 수행하지 않고, 재시도 payload와 idempotency key만 고정한다. 실제 enqueue/worker
 * wiring은 runtime 조립 단계에서 같은 contract를 재사용한다.
 */
export interface NotificationRetryJobPlan {
  jobType: typeof notificationRetryJobType;
  idempotencyKey: string;
  payloadJson: JsonRecord;
  runAfter: TimestampInput;
  maxAttempts: number;
}

/**
 * provider failure threshold 평가에 필요한 누적 상태다.
 *
 * 런타임은 이전 dispatch 결과의 state를 다음 호출에 넘겨 연속 실패와 긴 장애를 판단한다. 성공 전송이 한 번 나오면
 * `evaluateNotificationFailure`가 상태를 reset한다.
 */
export interface NotificationFailureState {
  consecutiveFailures: number;
  firstFailureAt: TimestampInput | null;
  lastFailureAt: TimestampInput | null;
}

/**
 * notification failure 평가 결과다.
 *
 * manualReviewReasonCode가 있으면 kill switch mapping에서 `MANUAL_REVIEW_REQUIRED` 후보로 사용할 수 있다. 이 PR은 후보
 * reason code까지만 만들고 kill switch 전이를 직접 실행하지 않는다.
 */
export interface NotificationFailureEvaluation {
  state: NotificationFailureState;
  manualReviewReasonCode?: "notification_consecutive_failure" | "notification_failure_threshold_exceeded";
}

/**
 * alert dispatch 한 번의 최종 결과다.
 *
 * cooldownHit은 provider 호출 여부를 빠르게 구분하기 위한 flag다. notification은 실제 전송 결과 또는 skip 이유를 담고,
 * retryJobPlan은 P0/P1 provider failure에만 선택적으로 붙는다.
 */
export interface AlertDispatchResult {
  fingerprint: string;
  cooldownHit: boolean;
  notification: NotificationResult;
  retryJobPlan?: NotificationRetryJobPlan;
  failureEvaluation: NotificationFailureEvaluation;
}

/**
 * alert dispatch service를 조립하는 의존성 묶음이다.
 *
 * durableCooldownStore는 P0/P1에 필수이며 memoryCooldownStore는 P2/P3 기본 store를 대체할 때만 넣는다. auditLog는 선택
 * port로 두어 unit test와 후속 runtime wiring이 같은 service를 공유할 수 있게 한다. deliveryReservationMs는 provider
 * 호출이 끝나기 전 같은 fingerprint가 중복 전송되는 경합을 막는 lease 길이다.
 */
export interface AlertDispatchServiceOptions {
  notifier: NotifierPort;
  durableCooldownStore: AlertCooldownStore;
  memoryCooldownStore?: AlertCooldownStore;
  auditLog?: AuditLogPort;
  clock?: () => Date;
  failureState?: NotificationFailureState;
  deliveryReservationMs?: number;
}

/**
 * alert fingerprint의 기본 구성 요소를 운영 정책에 맞춰 결합한다.
 *
 * 기본 구성은 `environment + run_mode + severity + alert_type + market_or_global + strategy_id_or_global + reason_code`다.
 * 이 값이 cooldown key와 Telegram retry job key의 기준이므로, 공백과 대소문자 차이를 canonical form으로 줄인다.
 */
export function createAlertFingerprint(input: AlertFingerprintInput): string {
  return [
    "alert",
    normalizeFingerprintPart(input.environment),
    normalizeFingerprintPart(input.runMode),
    input.severity,
    normalizeFingerprintPart(input.alertType),
    normalizeFingerprintPart(input.market ?? "global"),
    normalizeFingerprintPart(input.strategyId ?? "global"),
    normalizeFingerprintPart(input.reasonCode),
  ].join(":");
}

/**
 * severity별 기본 cooldown window를 millisecond로 반환한다.
 *
 * P0/P1은 운영자가 즉시 봐야 하지만 반복 장애가 알림 폭주로 번지면 복구 판단이 어려워진다. P2/P3은 낮은 우선순위라
 * 더 긴 memory cooldown을 기본으로 둔다.
 */
export function getDefaultAlertCooldownMs(severity: AlertSeverity): number {
  switch (severity) {
    case "P0":
      return 60_000;
    case "P1":
      return 5 * 60_000;
    case "P2":
      return 60 * 60_000;
    case "P3":
      return 6 * 60 * 60_000;
  }
}

/**
 * alert severity가 durable cooldown 대상인지 판단한다.
 *
 * P0/P1은 재시작 후에도 중복 전송을 억제해야 하므로 DB-backed store를 사용한다. P2/P3은 M8 범위에서 memory 우선 정책을
 * 사용해 schema churn을 줄인다.
 */
export function usesDurableCooldown(severity: AlertSeverity): boolean {
  return severity === "P0" || severity === "P1";
}

/**
 * alert를 cooldown 정책과 notifier provider에 연결한다.
 *
 * 흐름:
 * 1. fingerprint를 만든다.
 * 2. severity에 따라 durable 또는 memory cooldown store를 고른다.
 * 3. provider 호출 전에 fingerprint 단위 delivery reservation을 atomic하게 잡는다.
 * 4. cooldown 또는 in-flight reservation이 있으면 provider 호출 없이 skip evidence를 남긴다.
 * 5. 전송 실패면 P0/P1 retry job 후보와 notification failure 상태를 만든다.
 */
export async function dispatchAlertWithCooldown(
  options: AlertDispatchServiceOptions,
  request: AlertDispatchRequest,
): Promise<AlertDispatchResult> {
  const reservationAt = currentTime(options);
  const alertOccurredAt = request.occurredAt ?? reservationAt;
  const fingerprint = createAlertFingerprint(request);
  const store = selectCooldownStore(options, request.severity);
  const reservationRecordInput = toCooldownRecordInput(request, fingerprint, reservationAt);
  const reservation = await store.reserveDelivery({
    ...reservationRecordInput,
    cooldownMs: getDefaultAlertCooldownMs(request.severity),
    reserveUntil: addMs(reservationAt, options.deliveryReservationMs ?? defaultAlertDeliveryReservationMs),
  });

  if (!reservation.reserved) {
    const blockedDelivery = describeBlockedDelivery(
      reservation.state,
      request.severity,
      reservationAt,
    );
    if (blockedDelivery.skippedReason === undefined) {
      throw new Error("Alert delivery reservation was rejected without an active cooldown reason");
    }
    // provider를 호출하지 않아도 cooldown/reservation hit 자체는 운영자가 추적해야 하므로 skip evidence를 남긴다.
    await store.recordSkipped(reservationRecordInput);
    await appendAlertAudit(options, request, fingerprint, reservationAt, "INFO", "alert_delivery_skipped", {
      blocked_until: blockedDelivery.until ?? null,
      skipped_reason: blockedDelivery.skippedReason,
    });
    return {
      fingerprint,
      cooldownHit: true,
      notification: {
        delivered: false,
        skippedReason: blockedDelivery.skippedReason,
      },
      failureEvaluation: preserveNotificationFailureState(options.failureState),
    };
  }

  const notification = await options.notifier.sendAlert({
    severity: request.severity,
    title: request.title,
    body: request.body,
    fingerprint,
    occurredAt: alertOccurredAt,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  });
  const deliveryCompletedAt = currentTime(options);
  const failureEvaluation = evaluateNotificationFailure(
    options.failureState,
    notification,
    deliveryCompletedAt,
  );

  if (notification.delivered) {
    // 실제 provider 전송 완료 시각만 cooldown 기준점으로 기록해 지연된 요청 시각 때문에 보호 창이 줄어들지 않게 한다.
    await store.recordSent(toCooldownRecordInput(request, fingerprint, deliveryCompletedAt));
    await appendAlertAudit(options, request, fingerprint, deliveryCompletedAt, "INFO", "notification_delivered", {
      provider_message_id: notification.providerMessageId ?? null,
    });
    return {
      fingerprint,
      cooldownHit: false,
      notification,
      failureEvaluation,
    };
  }

  // P0/P1 provider failure는 즉시 운영 위험이므로 retry job 후보와 audit evidence를 함께 남긴다.
  const retryJobPlan = usesDurableCooldown(request.severity)
    ? createNotificationRetryJobPlan({ request, fingerprint, occurredAt: alertOccurredAt })
    : undefined;
  await appendAlertAudit(options, request, fingerprint, deliveryCompletedAt, "ERROR", "notification_failure", {
    skipped_reason: notification.skippedReason ?? "notification_provider_failure",
    retry_job: retryJobPlan ?? null,
    manual_review_reason_code: failureEvaluation.manualReviewReasonCode ?? null,
  });

  return {
    fingerprint,
    cooldownHit: false,
    notification,
    ...(retryJobPlan === undefined ? {} : { retryJobPlan }),
    failureEvaluation,
  };
}

/**
 * P0/P1 notification failure가 재시도될 수 있도록 jobs table에 넣을 계획을 만든다.
 *
 * 이 함수는 실제 insert를 하지 않는다. Sub PR 3은 retry 후보 payload와 idempotency boundary만 고정하고, worker 실행은 후속
 * runtime 조립에서 연결한다.
 */
export function createNotificationRetryJobPlan(input: {
  request: AlertDispatchRequest;
  fingerprint: string;
  occurredAt: TimestampInput;
}): NotificationRetryJobPlan {
  const occurredAt = toIsoTimestamp(input.occurredAt);
  return {
    jobType: notificationRetryJobType,
    idempotencyKey: [notificationRetryJobType, input.fingerprint, occurredAt].join(":"),
    payloadJson: {
      severity: input.request.severity,
      title: input.request.title,
      body: input.request.body,
      fingerprint: input.fingerprint,
      occurred_at: occurredAt,
      correlation_id: input.request.correlationId ?? null,
      metadata: input.request.metadata ?? {},
    },
    runAfter: input.occurredAt,
    maxAttempts: 3,
  };
}

/**
 * notification provider 실패 누적 상태를 평가한다.
 *
 * 단발 실패는 audit만 남기고 계속 진행한다. 연속 3회 실패하거나 첫 실패 이후 10분 이상 전체 알림 실패가 이어지면
 * `MANUAL_REVIEW_REQUIRED` kill switch 후보 reason code를 반환한다.
 */
export function evaluateNotificationFailure(
  currentState: NotificationFailureState | undefined,
  result: NotificationResult,
  occurredAt: TimestampInput,
): NotificationFailureEvaluation {
  if (result.delivered) {
    return {
      state: {
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
      },
    };
  }

  const previous = currentState ?? {
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastFailureAt: null,
  };
  const firstFailureAt = previous.firstFailureAt ?? occurredAt;
  const state: NotificationFailureState = {
    consecutiveFailures: previous.consecutiveFailures + 1,
    firstFailureAt,
    lastFailureAt: occurredAt,
  };

  if (state.consecutiveFailures >= 3) {
    return {
      state,
      manualReviewReasonCode: "notification_consecutive_failure",
    };
  }

  if (toEpochMs(occurredAt) - toEpochMs(firstFailureAt) >= 10 * 60_000) {
    return {
      state,
      manualReviewReasonCode: "notification_failure_threshold_exceeded",
    };
  }

  return { state };
}

/**
 * provider를 호출하지 않은 경로에서 notification failure state를 그대로 유지한다.
 *
 * cooldown skip은 운영상 정상 억제지만 Telegram provider 성공도 아니다. 따라서 기존 provider 장애 누적을 성공처럼 reset하지
 * 않고 다음 실제 provider 호출까지 보존한다.
 */
function preserveNotificationFailureState(
  currentState: NotificationFailureState | undefined,
): NotificationFailureEvaluation {
  return {
    state: currentState ?? {
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastFailureAt: null,
    },
  };
}

/**
 * process-local P2/P3 cooldown store를 만든다.
 *
 * memory store는 재시작 후 보존되지 않으므로 P0/P1에는 사용하지 않는다. 낮은 우선순위 알림의 반복 전송을 한 프로세스 안에서
 * 줄이는 용도다.
 */
export function createInMemoryAlertCooldownStore(): AlertCooldownStore {
  const states = new Map<string, AlertCooldownState>();

  return {
    async findByFingerprint(fingerprint) {
      return states.get(fingerprint);
    },
    async reserveDelivery(input) {
      const previous = states.get(input.fingerprint);
      if (previous !== undefined && isDeliveryBlocked(previous, input.severity, input.occurredAt)) {
        return {
          reserved: false,
          state: previous,
        };
      }

      // provider 호출 전에 memory state에 lease를 먼저 남겨 같은 process 안의 동시 전송을 직렬화한다.
      const state = toCooldownState(
        input,
        previous?.lastSentAt ?? null,
        previous?.lastSkippedAt ?? null,
        input.reserveUntil,
      );
      states.set(input.fingerprint, state);
      return {
        reserved: true,
        state,
      };
    },
    async recordSent(input) {
      const previous = states.get(input.fingerprint);
      const state = toCooldownState(input, input.occurredAt, previous?.lastSkippedAt ?? null, null);
      states.set(input.fingerprint, state);
      return state;
    },
    async recordSkipped(input) {
      const previous = states.get(input.fingerprint);
      const state = toCooldownState(
        input,
        previous?.lastSentAt ?? null,
        latestTimestamp(previous?.lastSkippedAt ?? null, input.occurredAt),
        previous?.deliveryReservedUntil ?? null,
      );
      states.set(input.fingerprint, state);
      return state;
    },
  };
}

function selectCooldownStore(
  options: AlertDispatchServiceOptions,
  severity: AlertSeverity,
): AlertCooldownStore {
  if (usesDurableCooldown(severity)) {
    return options.durableCooldownStore;
  }

  return options.memoryCooldownStore ?? defaultMemoryAlertCooldownStore;
}

function isDeliveryBlocked(
  state: AlertCooldownState,
  severity: AlertSeverity,
  occurredAt: TimestampInput,
): boolean {
  return describeBlockedDelivery(state, severity, occurredAt).skippedReason !== undefined;
}

function describeBlockedDelivery(
  state: AlertCooldownState,
  severity: AlertSeverity,
  occurredAt: TimestampInput,
): { skippedReason?: "alert_cooldown_active" | "alert_delivery_reserved"; until?: string } {
  const occurredAtMs = toEpochMs(occurredAt);
  if (state.lastSentAt !== null) {
    const cooldownUntilMs = toEpochMs(state.lastSentAt) + getDefaultAlertCooldownMs(severity);
    if (occurredAtMs < cooldownUntilMs) {
      return {
        skippedReason: "alert_cooldown_active",
        until: new Date(cooldownUntilMs).toISOString(),
      };
    }
  }

  if (state.deliveryReservedUntil !== null && occurredAtMs < toEpochMs(state.deliveryReservedUntil)) {
    return {
      skippedReason: "alert_delivery_reserved",
      until: toIsoTimestamp(state.deliveryReservedUntil),
    };
  }

  return {};
}

function toCooldownRecordInput(
  request: AlertDispatchRequest,
  fingerprint: string,
  occurredAt: TimestampInput,
): AlertCooldownRecordInput {
  return {
    fingerprint,
    severity: request.severity,
    alertType: normalizeFingerprintPart(request.alertType),
    market: request.market === undefined ? null : normalizeFingerprintPart(request.market),
    strategyId: request.strategyId === undefined ? null : normalizeFingerprintPart(request.strategyId),
    reasonCode: normalizeFingerprintPart(request.reasonCode),
    occurredAt,
    payloadJson: {
      title: request.title,
      correlation_id: request.correlationId ?? null,
      metadata: request.metadata ?? {},
    },
  };
}

function toCooldownState(
  input: AlertCooldownRecordInput,
  lastSentAt: TimestampInput | null,
  lastSkippedAt: TimestampInput | null,
  deliveryReservedUntil: TimestampInput | null,
): AlertCooldownState {
  return {
    fingerprint: input.fingerprint,
    severity: input.severity,
    alertType: input.alertType,
    market: input.market,
    strategyId: input.strategyId,
    reasonCode: input.reasonCode,
    lastSentAt,
    lastSkippedAt,
    deliveryReservedUntil,
    payloadJson: input.payloadJson ?? {},
  };
}

async function appendAlertAudit(
  options: AlertDispatchServiceOptions,
  request: AlertDispatchRequest,
  fingerprint: string,
  occurredAt: TimestampInput,
  severity: "INFO" | "ERROR",
  reasonCode: string,
  metadata: JsonRecord,
): Promise<void> {
  if (options.auditLog === undefined) {
    return;
  }

  await options.auditLog.appendEvent({
    eventType: reasonCode.startsWith("alert_") ? "ALERT_COOLDOWN" : "NOTIFICATION_DELIVERY",
    severity,
    occurredAt,
    actor: "alert-dispatcher",
    reasonCode,
    ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
    ...(request.strategyId === undefined ? {} : { strategyId: request.strategyId }),
    metadata: {
      ...metadata,
      fingerprint,
      alert_type: request.alertType,
      alert_severity: request.severity,
      market: request.market ?? null,
    },
  });
}

function normalizeFingerprintPart(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[^a-z0-9_:-]+/gu, "_");
}

function toIsoTimestamp(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toEpochMs(value: TimestampInput): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function currentTime(options: Pick<AlertDispatchServiceOptions, "clock">): Date {
  return options.clock?.() ?? new Date();
}

function addMs(value: TimestampInput, ms: number): string {
  return new Date(toEpochMs(value) + ms).toISOString();
}

function latestTimestamp(
  current: TimestampInput | null,
  next: TimestampInput,
): TimestampInput {
  if (current === null) {
    return next;
  }

  return toEpochMs(current) >= toEpochMs(next) ? current : next;
}

const defaultMemoryAlertCooldownStore = createInMemoryAlertCooldownStore();
