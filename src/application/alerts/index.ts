import type {
  AlertNotification,
  AlertSeverity,
  AuditLogPort,
  NotificationResult,
  NotifierPort,
} from "../ports/index.js";
import type {
  KillSwitchControlRequest,
  KillSwitchControlResult,
} from "../risk/index.js";
import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export * from "./paper-trade-events.js";

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
 * provider 실패 후 delivery reservation을 해제할 때 필요한 소유권 검증 입력이다.
 *
 * `reservedUntil`은 이 dispatch가 예약할 때 기록한 lease 만료 시각이다. store 구현은 현재 row의
 * `delivery_reserved_until`이 이 값과 일치할 때만 해제해야 하며, 이미 다른 요청이 같은 fingerprint를 재예약했다면 새
 * lease를 보존해야 한다.
 */
export interface AlertCooldownReleaseInput extends AlertCooldownRecordInput {
  reservedUntil: TimestampInput;
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
  /**
   * provider 실패 후 전송 예약 lease만 해제한다.
   *
   * 실패를 cooldown 성공으로 기록하지 않으면서 다음 실제 재시도나 새 알림 evidence가 예약 창에 막히지 않게 한다. 단, 해제는
   * `reservedUntil`이 현재 lease와 일치하는 경우에만 수행해 늦게 끝난 provider 실패가 새 요청의 lease를 지우지 못하게 한다.
   */
  releaseDeliveryReservation(input: AlertCooldownReleaseInput): Promise<AlertCooldownState>;
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
 * notification retry job을 durable queue에 적재한 결과다.
 *
 * application layer는 jobs table 구현을 모르지만, retry 계획이 실제 재시도 경계로 예약됐는지는 알아야 한다. jobId는 저장소가
 * 제공할 수 있을 때만 채우며, created=false면 같은 idempotency key row를 재사용했다는 뜻이다.
 */
export interface NotificationRetryJobEnqueueReceipt {
  jobType: typeof notificationRetryJobType;
  idempotencyKey: string;
  created: boolean;
  jobId?: string;
}

/**
 * notification retry job을 durable queue에 적재하는 application port다.
 *
 * P0/P1 provider failure는 원 업무 commit 이후에 발생하므로 alert dispatch service는 이 port를 선택 의존성으로 호출한다.
 * 구현체는 jobs table 같은 durable queue에 idempotent하게 예약해야 하며, 실패하더라도 원 alert dispatch 결과를 예외로
 * 되돌리지 않는다.
 */
export interface NotificationRetryJobQueue {
  enqueueNotificationRetryJob(plan: NotificationRetryJobPlan): Promise<NotificationRetryJobEnqueueReceipt>;
}

/**
 * notification retry job 예약 실패를 alert dispatch 결과에 남기는 안전한 표현이다.
 *
 * retry 예약 자체가 실패해도 이미 끝난 주문/리스크/kill switch commit을 rollback하지 않는다. 대신 짧은 reason code와
 * 사람이 확인할 메시지를 audit metadata와 dispatch result에 남긴다.
 */
export interface NotificationRetryJobEnqueueFailure {
  reasonCode: "notification_retry_enqueue_failed";
  message: string;
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
  retryJobEnqueueReceipt?: NotificationRetryJobEnqueueReceipt;
  retryJobEnqueueFailure?: NotificationRetryJobEnqueueFailure;
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
  retryJobQueue?: NotificationRetryJobQueue;
  auditLog?: AuditLogPort;
  clock?: () => Date;
  failureState?: NotificationFailureState;
  deliveryReservationMs?: number;
}

/**
 * kill switch control 결과를 alert dispatch로 연결하기 위한 runtime 문맥이다.
 *
 * environment와 runMode는 fingerprint의 상위 운영 차원이다. provider/cooldown/audit 의존성은 일반 alert dispatch service와
 * 같지만, kill switch 전이는 HTTP control이나 자동 가드레일에서 발생할 수 있으므로 호출 경계를 별도 옵션으로 명시한다.
 */
export interface KillSwitchAlertDispatchOptions extends AlertDispatchServiceOptions {
  environment: string;
  runMode: string;
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
  const fingerprint = createAlertFingerprint(request);
  const store = selectCooldownStore(options, request.severity);
  let reservationContext = await reserveAlertDeliveryForDispatch(options, request, fingerprint, store);
  let blockedDelivery = reservationContext.reservation.reserved
    ? undefined
    : describeBlockedDelivery(
        reservationContext.reservation.state,
        request.severity,
        reservationContext.reservationAt,
      );

  if (!reservationContext.reservation.reserved && blockedDelivery?.skippedReason === undefined) {
    // 실패한 provider 호출이 lease를 해제한 직후일 수 있으므로 한 번 재예약해 전송 가능한 alert를 예외로 유실하지 않는다.
    reservationContext = await reserveAlertDeliveryForDispatch(options, request, fingerprint, store);
    blockedDelivery = reservationContext.reservation.reserved
      ? undefined
      : describeBlockedDelivery(
          reservationContext.reservation.state,
          request.severity,
          reservationContext.reservationAt,
        );
  }

  if (!reservationContext.reservation.reserved) {
    const skippedReason = blockedDelivery?.skippedReason ?? "alert_reservation_race";
    // provider를 호출하지 않아도 cooldown/reservation hit 자체는 운영자가 추적해야 하므로 skip evidence를 남긴다.
    await store.recordSkipped(reservationContext.recordInput);
    await appendAlertAudit(options, request, fingerprint, reservationContext.reservationAt, "INFO", "alert_delivery_skipped", {
      blocked_until: blockedDelivery?.until ?? null,
      skipped_reason: skippedReason,
    });
    return {
      fingerprint,
      cooldownHit: true,
      notification: {
        delivered: false,
        skippedReason,
      },
      failureEvaluation: preserveNotificationFailureState(options.failureState),
    };
  }

  const alertOccurredAt = request.occurredAt ?? reservationContext.reservationAt;
  const notification = await sendAlertSafely(options.notifier, {
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

  // 내가 잡은 lease만 해제해야 늦게 끝난 실패 cleanup이 새 요청의 reservation을 지워 dedupe를 깨지 않는다.
  await store.releaseDeliveryReservation({
    ...toCooldownRecordInput(request, fingerprint, deliveryCompletedAt),
    reservedUntil: reservationContext.reserveUntil,
  });

  // P0/P1 provider failure는 즉시 운영 위험이므로 retry job 후보와 audit evidence를 함께 남긴다.
  const retryJobPlan = usesDurableCooldown(request.severity)
    ? createNotificationRetryJobPlan({ request, fingerprint, occurredAt: alertOccurredAt })
    : undefined;
  const retryJobEnqueue = retryJobPlan === undefined || options.retryJobQueue === undefined
    ? undefined
    : await enqueueNotificationRetryJobSafely(options.retryJobQueue, retryJobPlan);
  await appendAlertAudit(options, request, fingerprint, deliveryCompletedAt, "ERROR", "notification_failure", {
    skipped_reason: notification.skippedReason ?? "notification_provider_failure",
    retry_job: retryJobPlan ?? null,
    retry_job_enqueue_receipt: retryJobEnqueue?.receipt ?? null,
    retry_job_enqueue_failure: retryJobEnqueue?.failure ?? null,
    manual_review_reason_code: failureEvaluation.manualReviewReasonCode ?? null,
  });

  return {
    fingerprint,
    cooldownHit: false,
    notification,
    ...(retryJobPlan === undefined ? {} : { retryJobPlan }),
    ...(retryJobEnqueue?.receipt === undefined ? {} : { retryJobEnqueueReceipt: retryJobEnqueue.receipt }),
    ...(retryJobEnqueue?.failure === undefined ? {} : { retryJobEnqueueFailure: retryJobEnqueue.failure }),
    failureEvaluation,
  };
}

/**
 * accepted kill switch control 전이를 Telegram alert dispatch 요청으로 변환해 전송한다.
 *
 * `NORMAL` 복구는 중복 operational noise를 피하기 위해 여기서 alert를 만들지 않는다. 주문 차단, HARD_STOP, 수동 검토처럼
 * 사람이 즉시 알아야 하는 상태만 P0/P1/P2 alert로 보낸다.
 */
export async function dispatchKillSwitchControlAlert(input: {
  alertDispatch: KillSwitchAlertDispatchOptions;
  controlRequest: KillSwitchControlRequest;
  controlResult: KillSwitchControlResult;
}): Promise<AlertDispatchResult | undefined> {
  const alertRequest = createKillSwitchControlAlertRequest(input);
  if (alertRequest === undefined) {
    return undefined;
  }

  return runWithFailureStateLock(input.alertDispatch, async () => {
    const result = await dispatchAlertWithCooldown(input.alertDispatch, alertRequest);
    // runtime 조립에서 같은 alertDispatch 객체를 재사용하면 provider failure threshold가 호출 간 누적된다.
    input.alertDispatch.failureState = result.failureEvaluation.state;
    return result;
  });
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
      environment: input.request.environment,
      run_mode: input.request.runMode,
      severity: input.request.severity,
      alert_type: input.request.alertType,
      market: input.request.market ?? null,
      strategy_id: input.request.strategyId ?? null,
      reason_code: input.request.reasonCode,
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
 * notification retry job payload를 다시 alert dispatch 요청으로 복원한다.
 *
 * jobs table payload는 JSON 경계라 필드 누락이나 잘못된 severity가 섞일 수 있다. retry worker는 이 함수를 통해 P0/P1만
 * 재전송 대상으로 받아들이고, 내부 식별자는 원래 fingerprint와 metadata에 보존한다. 이 함수는 순수 검증/복원만 수행하며
 * provider 호출이나 DB write 같은 외부 side effect는 없다.
 */
export function createAlertDispatchRequestFromNotificationRetryPayload(
  payloadJson: JsonRecord,
): AlertDispatchRequest {
  const severity = readNotificationRetrySeverity(payloadJson, "severity");
  if (!usesDurableCooldown(severity)) {
    throw new Error("notification retry payload severity must be P0 or P1");
  }

  const correlationId = readOptionalStringField(payloadJson, "correlation_id");
  const market = readOptionalStringField(payloadJson, "market");
  const strategyId = readOptionalStringField(payloadJson, "strategy_id");

  return {
    environment: readRequiredStringField(payloadJson, "environment"),
    runMode: readRequiredStringField(payloadJson, "run_mode"),
    severity,
    alertType: readRequiredStringField(payloadJson, "alert_type"),
    ...(market === undefined ? {} : { market }),
    ...(strategyId === undefined ? {} : { strategyId }),
    reasonCode: readRequiredStringField(payloadJson, "reason_code"),
    title: readRequiredStringField(payloadJson, "title"),
    body: readRequiredStringField(payloadJson, "body"),
    occurredAt: readRequiredStringField(payloadJson, "occurred_at"),
    ...(correlationId === undefined ? {} : { correlationId }),
    metadata: readOptionalJsonRecordField(payloadJson, "metadata") ?? {},
  };
}

/**
 * notification retry worker가 단일 job payload를 provider 재전송 경계로 실행한 결과다.
 *
 * `DELIVERED`는 provider 전송 성공, `COOLDOWN_SKIPPED`는 다른 경로에서 이미 같은 fingerprint가 처리되어 retry가 불필요한
 * 상태, `FAILED`는 provider 또는 alert dispatch 경계가 다시 실패해 jobs table retry/final failure로 넘겨야 하는 상태다.
 */
export interface NotificationRetryDispatchResult {
  status: "DELIVERED" | "COOLDOWN_SKIPPED" | "FAILED";
  alertDispatch: AlertDispatchResult;
  errorMessage?: string;
}

/**
 * notification retry job payload를 alert dispatch service로 재전송한다.
 *
 * retry worker는 jobs table claim 이후 이 함수를 호출한다. 성공 또는 cooldown skip은 job completion 대상이고, 실패는 worker가
 * `failJob`으로 재예약하거나 최종 실패 evidence를 남긴다. 이 함수는 durable queue 상태를 직접 바꾸지 않는다.
 */
export async function dispatchNotificationRetryJob(input: {
  alertDispatch: AlertDispatchServiceOptions;
  payloadJson: JsonRecord;
}): Promise<NotificationRetryDispatchResult> {
  const request = createAlertDispatchRequestFromNotificationRetryPayload(input.payloadJson);
  const result = await dispatchAlertWithCooldown(input.alertDispatch, request);

  if (result.notification.delivered) {
    return {
      status: "DELIVERED",
      alertDispatch: result,
    };
  }

  if (result.cooldownHit) {
    return {
      status: "COOLDOWN_SKIPPED",
      alertDispatch: result,
    };
  }

  const skippedReason = result.notification.skippedReason ?? "notification_retry_provider_failure";
  return {
    status: "FAILED",
    alertDispatch: result,
    errorMessage: `notification retry failed: ${skippedReason}`,
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

async function enqueueNotificationRetryJobSafely(
  queue: NotificationRetryJobQueue,
  plan: NotificationRetryJobPlan,
): Promise<{
  receipt?: NotificationRetryJobEnqueueReceipt;
  failure?: NotificationRetryJobEnqueueFailure;
}> {
  try {
    return {
      receipt: await queue.enqueueNotificationRetryJob(plan),
    };
  } catch (error) {
    // retry 예약 실패는 원 업무 commit을 되돌릴 수 없으므로 dispatch 결과와 audit evidence에만 남긴다.
    return {
      failure: {
        reasonCode: "notification_retry_enqueue_failed",
        message: toErrorMessage(error),
      },
    };
  }
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
    async releaseDeliveryReservation(input) {
      const previous = states.get(input.fingerprint);
      if (previous === undefined) {
        return toCooldownState(input, null, null, null);
      }

      if (!sameTimestamp(previous.deliveryReservedUntil, input.reservedUntil)) {
        // 늦게 끝난 실패 cleanup이 이미 재예약된 memory lease를 지우면 같은 프로세스 안의 dedupe 경계가 깨진다.
        return previous;
      }

      const state = toCooldownState(
        input,
        previous?.lastSentAt ?? null,
        previous?.lastSkippedAt ?? null,
        null,
      );
      // provider 실패는 cooldown 성공 기준점이 아니므로 in-flight lease만 지우고 sent/skip evidence는 보존한다.
      states.set(input.fingerprint, state);
      return state;
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

/**
 * 같은 runtime alert dispatch 옵션 객체에서 발생한 failureState 갱신을 순차 실행한다.
 *
 * `failureState`는 durable store가 아니라 런타임 조립 객체에 누적되는 provider 장애 상태다. 같은 프로세스에서 동시에
 * `/kill-switch` 요청이 들어오면 각 요청이 동일한 이전 상태를 읽고 서로의 증가분을 덮어쓸 수 있으므로, 호출자는 이 helper
 * 안에서 dispatch와 상태 반영을 하나의 임계 구역으로 실행해야 한다. 입력 옵션 객체 자체를 key로 사용하고 WeakMap에만
 * 보관하므로 runtime 종료나 옵션 교체 외의 외부 side effect는 없다.
 */
async function runWithFailureStateLock<T>(
  alertDispatch: KillSwitchAlertDispatchOptions,
  task: () => Promise<T>,
): Promise<T> {
  const previous = alertDispatchFailureStateLocks.get(alertDispatch) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  // 이전 dispatch 성공/실패와 무관하게 같은 옵션 객체의 다음 상태 갱신은 현재 작업 해제 뒤로 밀어둔다.
  const chained = previous.then(() => current, () => current);
  alertDispatchFailureStateLocks.set(alertDispatch, chained);

  await previous.catch(() => undefined);
  try {
    // failureState는 in-memory runtime 누적값이므로 같은 옵션 객체를 공유하는 dispatch끼리 순서를 보존한다.
    return await task();
  } finally {
    releaseCurrent?.();
    if (alertDispatchFailureStateLocks.get(alertDispatch) === chained) {
      alertDispatchFailureStateLocks.delete(alertDispatch);
    }
  }
}

async function reserveAlertDeliveryForDispatch(
  options: AlertDispatchServiceOptions,
  request: AlertDispatchRequest,
  fingerprint: string,
  store: AlertCooldownStore,
): Promise<{
  reservationAt: Date;
  reserveUntil: TimestampInput;
  recordInput: AlertCooldownRecordInput;
  reservation: AlertCooldownReservationResult;
}> {
  const reservationAt = currentTime(options);
  const reserveUntil = addMs(reservationAt, options.deliveryReservationMs ?? defaultAlertDeliveryReservationMs);
  const recordInput = toCooldownRecordInput(request, fingerprint, reservationAt);
  const reservation = await store.reserveDelivery({
    ...recordInput,
    cooldownMs: getDefaultAlertCooldownMs(request.severity),
    reserveUntil,
  });

  return {
    reservationAt,
    reserveUntil,
    recordInput,
    reservation,
  };
}

async function sendAlertSafely(
  notifier: NotifierPort,
  notification: AlertNotification,
): Promise<NotificationResult> {
  try {
    return await notifier.sendAlert(notification);
  } catch {
    // provider adapter가 예외를 던져도 retry/audit/failure threshold 경로가 동일하게 실행되도록 짧은 reason code로 낮춘다.
    return {
      delivered: false,
      skippedReason: "notification_provider_exception",
    };
  }
}

function createKillSwitchControlAlertRequest(input: {
  alertDispatch: KillSwitchAlertDispatchOptions;
  controlRequest: KillSwitchControlRequest;
  controlResult: KillSwitchControlResult;
}): AlertDispatchRequest | undefined {
  if (!input.controlResult.transition.accepted) {
    return undefined;
  }

  const severity = toKillSwitchAlertSeverity(input.controlResult.transition.toState);
  if (severity === undefined) {
    return undefined;
  }

  const transition = input.controlResult.transition;
  return {
    environment: input.alertDispatch.environment,
    runMode: input.alertDispatch.runMode,
    severity,
    alertType: "kill_switch_control",
    reasonCode: transition.reasonCode,
    title: `Kill switch ${transition.toState}`,
    body: [
      `state: ${transition.fromState} -> ${transition.toState}`,
      `reason: ${transition.reasonCode}`,
      `message: ${transition.message}`,
      `new_orders_blocked: ${input.controlResult.actionPlan.newOrdersBlocked}`,
      `requires_manual_review: ${input.controlResult.actionPlan.requiresManualReview}`,
    ].join("\n"),
    occurredAt: transition.event.occurredAt,
    correlationId: input.controlRequest.correlationId,
    metadata: {
      source: "kill_switch_control",
      // Telegram formatter가 raw enum 대신 한국어 상태/원인/영향 문구를 만들 수 있게 전이 근거를 구조화해 넘긴다.
      actor: input.controlRequest.actor ?? "kill-switch-control",
      correlation_id: input.controlRequest.correlationId ?? null,
      from_state: transition.fromState,
      to_state: transition.toState,
      reason_code: transition.reasonCode,
      transition_message: transition.message,
      reason_matches_target: input.controlResult.reasonMatchesTarget,
      recommended_target_state: input.controlResult.recommendedTargetState ?? null,
      audit_event_id: input.controlResult.auditEventId ?? null,
      risk_event_id: input.controlResult.riskEventId ?? null,
      hard_stop_cancel_job: input.controlResult.hardStopCancelJob ?? null,
      action_plan: {
        new_orders_blocked: input.controlResult.actionPlan.newOrdersBlocked,
        strategy_evaluation_blocked: input.controlResult.actionPlan.strategyEvaluationBlocked,
        cancel_pending_paper_orders: input.controlResult.actionPlan.cancelPendingPaperOrders,
        auto_liquidate_open_positions: input.controlResult.actionPlan.autoLiquidateOpenPositions,
        requires_manual_review: input.controlResult.actionPlan.requiresManualReview,
      },
    },
  };
}

function toKillSwitchAlertSeverity(
  state: KillSwitchControlResult["transition"]["toState"],
): AlertSeverity | undefined {
  switch (state) {
    case "HARD_STOP":
      return "P0";
    case "MANUAL_REVIEW_REQUIRED":
    case "NEW_ORDERS_BLOCKED":
      return "P1";
    case "STRATEGY_PAUSED":
      return "P2";
    case "NORMAL":
      return undefined;
  }
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
  const normalized = value.trim().toLowerCase().replaceAll(/[^a-z0-9_:-]+/gu, "_");
  // fingerprint join 구분자인 ':'는 세그먼트 내부에서 percent-escape해 서로 다른 business key가 한 row로 충돌하지 않게 한다.
  return normalized.replaceAll(":", "%3a");
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

function sameTimestamp(left: TimestampInput | null | undefined, right: TimestampInput): boolean {
  return left !== null && left !== undefined && toEpochMs(left) === toEpochMs(right);
}

function readRequiredStringField(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`notification retry payload field ${key} must be a non-empty string`);
  }

  return value;
}

function readOptionalStringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`notification retry payload field ${key} must be a non-empty string when present`);
  }

  return value;
}

function readOptionalJsonRecordField(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`notification retry payload field ${key} must be an object when present`);
  }

  return value as JsonRecord;
}

function readNotificationRetrySeverity(record: JsonRecord, key: string): AlertSeverity {
  const value = readRequiredStringField(record, key);
  if (value !== "P0" && value !== "P1" && value !== "P2" && value !== "P3") {
    throw new Error(`notification retry payload field ${key} must be a known severity`);
  }

  return value;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultMemoryAlertCooldownStore = createInMemoryAlertCooldownStore();
const alertDispatchFailureStateLocks = new WeakMap<KillSwitchAlertDispatchOptions, Promise<void>>();
