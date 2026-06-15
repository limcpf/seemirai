import {
  createLiveOpsAlertRequest,
  dispatchLiveOpsAlert,
} from "../../application/index.js";
import type {
  AlertDispatchRequest,
  AlertDispatchResult,
  AlertDispatchServiceOptions,
  LiveOpsAlertEventKind,
  LiveOpsAlertInput,
} from "../../application/index.js";
import type {
  JsonRecord,
  OrderIntent,
} from "../../domain/index.js";
import {
  loadLiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsLiveExecutionSummary,
} from "../live-ops-live-execution.js";

/**
 * production live ops Telegram alert plan의 상태다.
 *
 * 책임:
 * - provider 호출 전 단계에서 Telegram 알림 계획이 준비됐는지, 설정/연결 문제로 차단됐는지, 전송할 이벤트가 없어 생략됐는지
 *   안정적으로 표현한다.
 * - TUI/JSON summary가 내부 alert enum 대신 한국어 message/action을 먼저 보여주게 한다.
 */
export type LiveOpsTelegramAlertPlanStatus = "ready" | "blocked" | "skipped";

/**
 * production live ops Telegram alert plan의 개별 guard 결과다.
 *
 * 책임:
 * - config, Telegram 연결, lifecycle mapper, trade mapper의 판단을 분리해 운영자가 어떤 단계에서 알림이 막혔는지 확인하게 한다.
 * - details에는 secret, raw Telegram response, raw provider payload를 넣지 않는 것이 invariant다.
 */
export interface LiveOpsTelegramAlertCheck {
  readonly name: "config" | "telegram_connection" | "lifecycle_alert" | "trade_alert";
  readonly status: "ok" | "blocked" | "skipped";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * production live ops Telegram alert mapper 입력 계약이다.
 *
 * 책임:
 * - live ops config와 live execution summary를 M23 live alert event 후보로 낮춘다.
 * - caller가 이미 검증한 Telegram outbound readiness를 boolean/evidence로 전달하게 해 env boolean만으로 readiness를 만들지 않게 한다.
 *
 * 호출 경계:
 * - 이 mapper는 provider 호출이나 cooldown 저장을 하지 않는다.
 * - 실제 Telegram 전송은 `dispatchLiveOpsTelegramAlerts`가 `AlertDispatchServiceOptions`를 받은 뒤 수행한다.
 */
export interface LiveOpsTelegramAlertPlanInput {
  readonly config: LiveOpsConfig | unknown;
  readonly environment: string;
  readonly runMode: string;
  readonly observedAt: string;
  readonly telegramReady: boolean;
  readonly liveExecution: LiveOpsLiveExecutionSummary;
  /**
   * live execution summary만으로 표현되지 않는 cancel/block event를 후속 reconcile/exit 경계가 명시할 때 사용한다.
   *
   * caller는 이미 주문/취소/reconcile evidence가 확정된 뒤에만 이 값을 넘겨야 하며, mapper는 provider 호출 없이 alert event로만
   * 낮춘다. 이 필드는 Telegram provider side effect를 만들지 않는다.
   */
  readonly tradeEventKind?: Extract<
    LiveOpsAlertEventKind,
    | "ORDER_SUBMITTED"
    | "CANCEL_REQUESTED"
    | "CANCEL_CONFIRMED"
    | "RISK_BLOCKED"
    | "COST_BLOCKED"
    | "RECONCILE_BLOCKED"
  >;
  readonly orderIntent?: OrderIntent;
  readonly correlationId?: string;
  readonly telegramConnectionEvidenceId?: string;
  readonly liveOrderCapableEvidenceId?: string;
  readonly tradeEvidenceId?: string;
  readonly trace?: JsonRecord;
}

/**
 * Telegram provider 호출 전 production live ops alert 계획이다.
 *
 * 책임:
 * - lifecycle/trade event 후보와 application alert dispatch request를 함께 보존해 테스트, TUI, 실제 dispatch가 같은 mapper를 쓰게 한다.
 * - `events`에는 `LiveOpsAlertInput`, `requests`에는 cooldown/retry가 사용할 `AlertDispatchRequest`를 담는다.
 *
 * side effect:
 * - plan 생성은 순수 변환이며 Telegram provider, cooldown store, retry queue, audit log를 호출하지 않는다.
 */
export interface LiveOpsTelegramAlertPlan {
  readonly status: LiveOpsTelegramAlertPlanStatus;
  readonly ready: boolean;
  readonly market: string;
  readonly observedAt: string;
  readonly liveOrderCapable: boolean;
  readonly lifecycleAlertCount: number;
  readonly tradeAlertCount: number;
  readonly alertCount: number;
  readonly providerDispatchAttempted: false;
  readonly message: string;
  readonly action: string;
  readonly checks: readonly LiveOpsTelegramAlertCheck[];
  readonly events: readonly LiveOpsAlertInput[];
  readonly requests: readonly AlertDispatchRequest[];
  readonly trace: JsonRecord;
}

/**
 * production live ops Telegram alert 전송 입력이다.
 *
 * 책임:
 * - 순수 plan과 alert dispatch 의존성을 결합해 실제 Telegram/cooldown/retry 경계로 전진시킨다.
 * - plan이 blocked/skipped이면 provider 호출 없이 summary만 반환해야 한다.
 */
export interface DispatchLiveOpsTelegramAlertsInput {
  readonly plan: LiveOpsTelegramAlertPlan;
  readonly alertDispatch: AlertDispatchServiceOptions;
}

/**
 * production live ops Telegram alert 전송 결과 요약이다.
 *
 * 책임:
 * - provider 성공, cooldown skip, retry 후보 수를 TUI/JSON에서 secret 없이 확인할 수 있게 한다.
 * - 개별 `AlertDispatchResult`는 retry/audit 추적을 위해 보존하되 token, raw provider response는 포함하지 않는 dispatch 계층 계약을 따른다.
 */
export interface DispatchLiveOpsTelegramAlertsSummary {
  readonly status: "sent" | "skipped" | "partial_failure";
  readonly attemptedCount: number;
  readonly deliveredCount: number;
  readonly cooldownHitCount: number;
  readonly retryPlannedCount: number;
  readonly failureCount: number;
  readonly message: string;
  readonly action: string;
  readonly results: readonly AlertDispatchResult[];
  readonly trace: JsonRecord;
}

/**
 * production live ops lifecycle/trade 상태를 Telegram alert 후보로 변환한다.
 *
 * @param input live ops config, Telegram readiness evidence, live execution summary, 선택 주문 intent
 * @returns provider 호출 없는 alert plan과 dispatch request 목록
 */
export function planLiveOpsTelegramAlerts(input: LiveOpsTelegramAlertPlanInput): LiveOpsTelegramAlertPlan {
  const config = loadLiveOpsConfig(input.config);
  const checks: LiveOpsTelegramAlertCheck[] = [
    okCheck("config", "production live ops Telegram 설정을 확인했습니다.", "live_ops_telegram_config_ok", {
      startupAlertEnabled: config.telegram.startup_alert_enabled,
      liveOrderCapableAlertEnabled: config.telegram.live_order_capable_alert_enabled,
      tradeEventAlertsEnabled: config.telegram.trade_event_alerts_enabled,
    }),
  ];

  if (!input.telegramReady) {
    // outbound readiness가 확정되지 않으면 startup alert를 보내려다 provider 실패만 만들 수 있어 plan 단계에서 닫는다.
    checks.push(blockedCheck(
      "telegram_connection",
      "Telegram outbound readiness가 없어 lifecycle/trade alert를 만들지 않습니다.",
      "live_ops_telegram_not_ready",
    ));
    return buildPlan(config, input, checks, [], {
      status: "blocked",
      ready: false,
      message: "Telegram 알림 채널 준비가 확인되지 않아 알림 계획을 만들지 않았습니다.",
      action: "bot token, chat id, provider timeout, owner 운영 채널을 확인합니다.",
    });
  }

  checks.push(okCheck("telegram_connection", "Telegram outbound readiness를 확인했습니다.", "live_ops_telegram_ready", {
    evidenceId: input.telegramConnectionEvidenceId ?? null,
  }));

  const events = [
    ...createLifecycleEvents(config, input, checks),
    ...createTradeEvents(config, input, checks),
  ];
  if (events.length === 0) {
    return buildPlan(config, input, checks, events, {
      status: "skipped",
      ready: true,
      message: "이번 tick에서 전송할 Telegram lifecycle/trade alert가 없습니다.",
      action: "다음 lifecycle 또는 trade event가 확정되면 같은 mapper로 alert를 생성합니다.",
    });
  }

  return buildPlan(config, input, checks, events, {
    status: "ready",
    ready: true,
    message: "Telegram lifecycle/trade alert 계획을 만들었습니다.",
    action: "provider dispatch 전 cooldown/retry/audit 상태를 확인합니다.",
  });
}

/**
 * alert plan을 실제 dispatch 경계로 전송한다.
 *
 * @param input 순수 alert plan과 alert dispatch service 의존성
 * @returns provider/cooldown/retry 결과 요약
 */
export async function dispatchLiveOpsTelegramAlerts(
  input: DispatchLiveOpsTelegramAlertsInput,
): Promise<DispatchLiveOpsTelegramAlertsSummary> {
  if (input.plan.status !== "ready") {
    // blocked/skipped plan은 provider 호출이 side effect를 만들 명분이 없으므로 그대로 종료한다.
    return {
      status: "skipped",
      attemptedCount: 0,
      deliveredCount: 0,
      cooldownHitCount: 0,
      retryPlannedCount: 0,
      failureCount: 0,
      message: input.plan.message,
      action: input.plan.action,
      results: [],
      trace: {
        source: "live_ops_telegram_alerts",
        planStatus: input.plan.status,
      },
    };
  }

  const results: AlertDispatchResult[] = [];
  let failureCount = 0;

  for (const event of input.plan.events) {
    try {
      results.push(await dispatchLiveOpsAlert({
        alertDispatch: input.alertDispatch,
        event,
      }));
    } catch {
      // 알림 dispatch 실패가 주문/리스크 commit을 되돌리면 운영 상태가 더 불명확해지므로 실패 count로만 격리한다.
      failureCount += 1;
    }
  }

  const deliveredCount = results.filter((result) => result.notification.delivered).length;
  const cooldownHitCount = results.filter((result) => result.cooldownHit).length;
  const retryPlannedCount = results.filter((result) => result.retryJobPlan !== undefined).length;

  return {
    status: failureCount > 0 ? "partial_failure" : "sent",
    attemptedCount: input.plan.events.length,
    deliveredCount,
    cooldownHitCount,
    retryPlannedCount,
    failureCount,
    message: failureCount > 0
      ? "일부 Telegram alert dispatch 결과를 확정하지 못했습니다."
      : "Telegram alert dispatch를 완료했습니다.",
    action: failureCount > 0
      ? "notification retry job과 provider 상태를 확인합니다."
      : "전송 결과와 cooldown 상태를 status surface에서 확인합니다.",
    results,
    trace: {
      source: "live_ops_telegram_alerts",
      planStatus: input.plan.status,
      alertCount: input.plan.alertCount,
    },
  };
}

function createLifecycleEvents(
  config: LiveOpsConfig,
  input: LiveOpsTelegramAlertPlanInput,
  checks: LiveOpsTelegramAlertCheck[],
): LiveOpsAlertInput[] {
  const events: LiveOpsAlertInput[] = [];

  if (config.telegram.startup_alert_enabled) {
    const event = createBaseEvent(input, "TELEGRAM_CONNECTION_READY");
    event.operatingMode = "live_armed";
    event.liveOrderCapable = false;
    event.safeSummary = "production live ops Telegram 알림 채널 readiness가 확인됐습니다.";
    assignIfDefined(event, "evidenceId", input.telegramConnectionEvidenceId);
    events.push(event);
  }

  if (config.telegram.live_order_capable_alert_enabled && input.liveExecution.liveOrderCapable) {
    const event = createBaseEvent(input, "LIVE_ORDER_CAPABLE_STARTED");
    event.market = input.liveExecution.market;
    event.operatingMode = "live_order_capable";
    event.liveOrderCapable = true;
    event.safeSummary = "production live ops가 실주문 가능 실행 경계까지 전진했습니다.";
    assignIfDefined(event, "strategyId", input.orderIntent?.strategyId);
    assignIfDefined(event, "evidenceId", input.liveOrderCapableEvidenceId ?? input.liveExecution.attemptId ?? undefined);
    events.push(event);
  }

  checks.push(okCheck("lifecycle_alert", "Telegram lifecycle alert 후보를 계산했습니다.", "live_ops_lifecycle_alerts_planned", {
    count: events.length,
  }));
  return events;
}

function createTradeEvents(
  config: LiveOpsConfig,
  input: LiveOpsTelegramAlertPlanInput,
  checks: LiveOpsTelegramAlertCheck[],
): LiveOpsAlertInput[] {
  if (!config.telegram.trade_event_alerts_enabled) {
    checks.push(skippedCheck("trade_alert", "Telegram trade event alert가 설정에서 비활성입니다.", "live_ops_trade_alerts_disabled"));
    return [];
  }

  const event = mapLiveExecutionToTradeEvent(input);
  if (event === undefined) {
    checks.push(skippedCheck("trade_alert", "이번 tick에는 Telegram trade alert로 보낼 실행 event가 없습니다.", "live_ops_trade_alerts_skipped"));
    return [];
  }

  checks.push(okCheck("trade_alert", "Telegram trade alert 후보를 계산했습니다.", "live_ops_trade_alerts_planned", {
    eventKind: event.eventKind,
  }));
  return [event];
}

function mapLiveExecutionToTradeEvent(input: LiveOpsTelegramAlertPlanInput): LiveOpsAlertInput | undefined {
  if (input.tradeEventKind !== undefined) {
    return createExplicitTradeEvent(input, input.tradeEventKind);
  }

  const liveExecution = input.liveExecution;
  if (liveExecution.status === "idle" || liveExecution.attemptedOrderCount === 0) {
    return undefined;
  }

  if (liveExecution.status === "submitted") {
    return createOrderSubmittedEvent(input);
  }

  if (liveExecution.status === "reconcile_required") {
    return createBlockedTradeEvent(input, "RECONCILE_BLOCKED");
  }

  if (liveExecution.status === "manual_review_required") {
    const event = createBaseEvent(input, "MANUAL_REVIEW_REQUIRED");
    event.market = liveExecution.market;
    event.liveOrderCapable = false;
    event.safeSummary = liveExecution.message;
    event.safeDetails = {
      execution_status: liveExecution.status,
      attempt_status: liveExecution.attemptStatus,
    };
    assignIfDefined(event, "strategyId", input.orderIntent?.strategyId);
    assignIfDefined(event, "evidenceId", input.tradeEvidenceId ?? liveExecution.attemptId ?? undefined);
    return event;
  }

  if (liveExecution.status === "rejected") {
    return createBlockedTradeEvent(input, "RISK_BLOCKED");
  }

  // generic blocked summary는 wiring/readiness 차단도 포함하므로 명시적 evidence 없이 RiskGate alert로 낮추지 않는다.
  return undefined;
}

function createExplicitTradeEvent(
  input: LiveOpsTelegramAlertPlanInput,
  eventKind: NonNullable<LiveOpsTelegramAlertPlanInput["tradeEventKind"]>,
): LiveOpsAlertInput {
  if (eventKind === "ORDER_SUBMITTED") {
    return createOrderSubmittedEvent(input);
  }

  if (eventKind === "RISK_BLOCKED" || eventKind === "COST_BLOCKED" || eventKind === "RECONCILE_BLOCKED") {
    return createBlockedTradeEvent(input, eventKind);
  }

  return createOrderProgressEvent(input, eventKind);
}

function createOrderSubmittedEvent(input: LiveOpsTelegramAlertPlanInput): LiveOpsAlertInput {
  const intent = input.orderIntent;
  const event = createBaseEvent(input, "ORDER_SUBMITTED");
  event.market = input.liveExecution.market;
  event.liveOrderCapable = true;
  event.safeSummary = input.liveExecution.message;
  event.safeDetails = {
    execution_status: input.liveExecution.status,
    attempt_status: input.liveExecution.attemptStatus,
  };
  assignIfDefined(event, "strategyId", intent?.strategyId);
  assignIfDefined(event, "orderId", input.liveExecution.attemptId ?? undefined);
  assignIfDefined(event, "brokerOrderId", input.liveExecution.brokerOrderId ?? undefined);
  assignIfDefined(event, "idempotencyKey", input.liveExecution.idempotencyKey ?? undefined);
  assignIfDefined(event, "evidenceId", input.tradeEvidenceId);

  if (intent !== undefined) {
    assignIfDefined(event, "side", intent.side);
    assignIfDefined(event, "quantity", intent.requestedQuantity);
    assignIfDefined(event, "notionalKrw", intent.requestedNotional);
    if (intent.orderType === "LIMIT") {
      assignIfDefined(event, "requestedPrice", intent.requestedPrice);
    }
  }

  return event;
}

function createBlockedTradeEvent(
  input: LiveOpsTelegramAlertPlanInput,
  eventKind: Extract<LiveOpsAlertEventKind, "RISK_BLOCKED" | "COST_BLOCKED" | "RECONCILE_BLOCKED">,
): LiveOpsAlertInput {
  const event = createBaseEvent(input, eventKind);
  event.market = input.liveExecution.market;
  event.liveOrderCapable = false;
  event.blockedReason = input.liveExecution.message;
  event.safeSummary = input.liveExecution.message;
  event.safeDetails = {
    execution_status: input.liveExecution.status,
    attempt_status: input.liveExecution.attemptStatus,
  };
  assignIfDefined(event, "strategyId", input.orderIntent?.strategyId);
  assignIfDefined(event, "evidenceId", input.tradeEvidenceId ?? input.liveExecution.attemptId ?? undefined);
  return event;
}

function createOrderProgressEvent(
  input: LiveOpsTelegramAlertPlanInput,
  eventKind: Extract<LiveOpsAlertEventKind, "CANCEL_REQUESTED" | "CANCEL_CONFIRMED">,
): LiveOpsAlertInput {
  const intent = input.orderIntent;
  const event = createBaseEvent(input, eventKind);
  event.market = input.liveExecution.market;
  event.liveOrderCapable = false;
  event.safeSummary = input.liveExecution.message;
  event.safeDetails = {
    execution_status: input.liveExecution.status,
    attempt_status: input.liveExecution.attemptStatus,
  };
  assignIfDefined(event, "strategyId", intent?.strategyId);
  assignIfDefined(event, "orderId", input.liveExecution.attemptId ?? undefined);
  assignIfDefined(event, "brokerOrderId", input.liveExecution.brokerOrderId ?? undefined);
  assignIfDefined(event, "idempotencyKey", input.liveExecution.idempotencyKey ?? undefined);
  assignIfDefined(event, "evidenceId", input.tradeEvidenceId ?? input.liveExecution.attemptId ?? undefined);

  if (intent !== undefined) {
    assignIfDefined(event, "side", intent.side);
    assignIfDefined(event, "quantity", intent.requestedQuantity);
    assignIfDefined(event, "notionalKrw", intent.requestedNotional);
    if (intent.orderType === "LIMIT") {
      assignIfDefined(event, "requestedPrice", intent.requestedPrice);
    }
  }

  return event;
}

function createBaseEvent(
  input: LiveOpsTelegramAlertPlanInput,
  eventKind: LiveOpsAlertEventKind,
): LiveOpsAlertInput {
  const event: LiveOpsAlertInput = {
    environment: input.environment,
    runMode: input.runMode,
    eventKind,
    occurredAt: input.observedAt,
    operatingMode: "live_armed",
  };

  assignIfDefined(event, "correlationId", input.correlationId);
  return event;
}

function buildPlan(
  config: LiveOpsConfig,
  input: LiveOpsTelegramAlertPlanInput,
  checks: readonly LiveOpsTelegramAlertCheck[],
  events: readonly LiveOpsAlertInput[],
  result: {
    status: LiveOpsTelegramAlertPlanStatus;
    ready: boolean;
    message: string;
    action: string;
  },
): LiveOpsTelegramAlertPlan {
  const requests = events.map((event) => createLiveOpsAlertRequest(event));
  return {
    status: result.status,
    ready: result.ready,
    market: config.universe.default_market,
    observedAt: input.observedAt,
    liveOrderCapable: input.liveExecution.liveOrderCapable,
    lifecycleAlertCount: events.filter((event) => isLifecycleEvent(event.eventKind)).length,
    tradeAlertCount: events.filter((event) => !isLifecycleEvent(event.eventKind)).length,
    alertCount: events.length,
    providerDispatchAttempted: false,
    message: result.message,
    action: result.action,
    checks,
    events,
    requests,
    trace: {
      source: "live_ops_telegram_alerts",
      liveExecutionStatus: input.liveExecution.status,
      telegramReady: input.telegramReady,
      ...(input.trace ?? {}),
    },
  };
}

function isLifecycleEvent(eventKind: LiveOpsAlertEventKind): boolean {
  return (
    eventKind === "TELEGRAM_CONNECTION_READY" ||
    eventKind === "LIVE_ORDER_CAPABLE_STARTED" ||
    eventKind === "NORMAL_SHUTDOWN" ||
    eventKind === "OPERATOR_STOP" ||
    eventKind === "KILL_SWITCH_STOP" ||
    eventKind === "MANUAL_REVIEW_REQUIRED" ||
    eventKind === "CRASH_DETECTED" ||
    eventKind === "RESTART_DETECTED" ||
    eventKind === "RECOVERY_COMPLETED" ||
    eventKind === "TELEGRAM_PROVIDER_FAILURE_SUSTAINED"
  );
}

function okCheck(
  name: LiveOpsTelegramAlertCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsTelegramAlertCheck {
  const check: LiveOpsTelegramAlertCheck = { name, status: "ok", code, message };
  return details === undefined ? check : { ...check, details };
}

function blockedCheck(
  name: LiveOpsTelegramAlertCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsTelegramAlertCheck {
  const check: LiveOpsTelegramAlertCheck = { name, status: "blocked", code, message };
  return details === undefined ? check : { ...check, details };
}

function skippedCheck(
  name: LiveOpsTelegramAlertCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsTelegramAlertCheck {
  const check: LiveOpsTelegramAlertCheck = { name, status: "skipped", code, message };
  return details === undefined ? check : { ...check, details };
}

function assignIfDefined(record: LiveOpsAlertInput, key: keyof LiveOpsAlertInput, value: unknown): void {
  if (value !== undefined) {
    (record as unknown as Record<string, unknown>)[key] = value;
  }
}
