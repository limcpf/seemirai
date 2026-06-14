import type {
  LiveAutonomousEntryAttemptResult,
  LiveAutonomousEntryCostInput,
  LiveAutonomousEntryLossSnapshot,
  LiveAutonomousEntryRiskInput,
  LiveAutonomousEntryRuntimeConfig,
  LiveAutonomousEntryRuntimeRequest,
} from "../../application/index.js";
import type {
  JsonRecord,
  LiveAutonomousBudgetSnapshot,
  OrderIntent,
} from "../../domain/index.js";
import {
  loadLiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsAnalysisDecisionSummary,
} from "../live-ops-analysis-decision.js";

/**
 * production live ops live execution worker의 최종 상태다.
 *
 * 책임:
 * - TUI/Telegram/status가 broker 제출 없음, 차단, 제출, 수동 점검을 안정적으로 분기하게 한다.
 * - 내부 M22 attempt status를 그대로 사용자 첫 화면에 노출하지 않고 운영 행동 언어로 낮추는 경계를 제공한다.
 *
 * invariant:
 * - `submitted` 외 상태는 이 adapter가 새 broker side effect를 성공으로 판정하지 않았다는 뜻이다.
 */
export type LiveOpsLiveExecutionStatus =
  | "idle"
  | "blocked"
  | "submitted"
  | "rejected"
  | "manual_review_required"
  | "reconcile_required";

/**
 * live execution adapter의 개별 guard 결과다.
 *
 * 책임:
 * - config, analysis summary, order intent, live autonomous request, execution result의 차단 지점을 분리한다.
 * - `details`에는 secret이나 raw provider payload가 아닌 count/status/evidence id 같은 안전 정보만 담는다.
 *
 * side effect:
 * - 이 구조체 자체는 읽기 전용 결과이며 DB write, broker 호출, notification 전송을 수행하지 않는다.
 */
export interface LiveOpsLiveExecutionCheck {
  readonly name: "config" | "analysis_decision" | "order_intent" | "execution_request" | "execution_result";
  readonly status: "ok" | "blocked";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * live execution adapter가 호출할 하위 entry runtime port다.
 *
 * 책임:
 * - production live ops adapter가 M22/M23 live autonomous entry service를 구체 class에 고정하지 않게 한다.
 * - 테스트와 실제 runtime 조립이 같은 `submitEntryCandidate` 호출 경계를 공유하게 한다.
 *
 * side effect:
 * - 구현체는 예산 reservation, broker submit, alert dispatch를 수행할 수 있으므로 adapter는 모든 guard를 통과한 뒤에만 호출해야 한다.
 */
export interface LiveOpsLiveExecutionEntryRuntime {
  submitEntryCandidate(request: LiveAutonomousEntryRuntimeRequest): Promise<LiveAutonomousEntryAttemptResult>;
}

/**
 * production live ops live execution adapter 입력 계약이다.
 *
 * 책임:
 * - analysis/decision에서 만든 주문 후보를 기존 live autonomous entry runtime 요청으로 낮춘다.
 * - budget, loss, cost, risk, kill switch, reconcile freshness snapshot을 같은 broker 제출 경계로 묶는다.
 *
 * 호출 경계:
 * - caller는 DB/status provider에서 최신 snapshot을 읽은 뒤 이 함수에 값으로 전달한다.
 * - 이 adapter는 `entryRuntime.submitEntryCandidate`를 호출할 수 있으며, 그 호출이 예산 reservation과 broker 제출 side effect의
 *   유일한 경계다.
 *
 * invariant:
 * - analysis가 ready가 아니거나 주문 후보 수가 0개/복수이면 broker 호출로 전진하지 않는다.
 * - 첫 production market은 `LiveOpsConfig` 검증 결과와 일치해야 한다.
 */
export interface LiveOpsLiveExecutionInput {
  readonly config: LiveOpsConfig | unknown;
  readonly analysisDecision: LiveOpsAnalysisDecisionSummary;
  readonly orderIntents: readonly OrderIntent[];
  readonly observedAt: string;
  readonly budgetSnapshot: LiveAutonomousBudgetSnapshot;
  readonly lossSnapshot: LiveAutonomousEntryLossSnapshot;
  readonly costInput: LiveAutonomousEntryCostInput;
  readonly risk: LiveAutonomousEntryRiskInput;
  readonly killSwitchActive: boolean;
  readonly reconcileFresh: boolean;
  readonly entryRuntime: LiveOpsLiveExecutionEntryRuntime;
  readonly referencePrice?: string;
  readonly idempotencyKey?: string;
  readonly trace?: JsonRecord;
}

/**
 * production live ops live execution adapter의 secret-safe 요약이다.
 *
 * 책임:
 * - 주문 후보가 없어서 쉬는 상태와 실제 broker 제출/차단 상태를 TUI/JSON/status가 같은 구조로 읽게 한다.
 * - broker order id, attempt id, reason code는 추적 정보로 보존하되 credential, raw API payload, token은 포함하지 않는다.
 *
 * 출력 의미:
 * - `liveOrderCapable=true`는 이번 호출에서 live autonomous execution 경계가 제출 가능 상태로 통과했음을 뜻한다.
 * - `attemptStatus`와 `brokerOrderId`는 실행 경계 이후 확인용이며, 주문 후보 없음 상태에서는 `null`이다.
 */
export interface LiveOpsLiveExecutionSummary {
  readonly status: LiveOpsLiveExecutionStatus;
  readonly ready: boolean;
  readonly liveOrderCapable: boolean;
  readonly market: string;
  readonly observedAt: string;
  readonly latestExecutionAt: string | null;
  readonly orderIntentCount: number;
  readonly attemptedOrderCount: number;
  readonly submittedOrderCount: number;
  readonly attemptStatus: string | null;
  readonly attemptId: string | null;
  readonly idempotencyKey: string | null;
  readonly brokerOrderId: string | null;
  readonly message: string;
  readonly action: string;
  readonly checks: readonly LiveOpsLiveExecutionCheck[];
  readonly trace: JsonRecord;
}

/**
 * analysis/decision 주문 후보를 production live autonomous execution 경계로 연결한다.
 *
 * @param input production config, analysis summary, order intent, 최신 예산/손실/비용/리스크/reconcile snapshot
 * @returns TUI와 JSON status가 사용할 수 있는 live execution safe summary
 *
 * side effect:
 * - 주문 후보가 정확히 1개이고 모든 adapter guard를 통과할 때만 `entryRuntime.submitEntryCandidate`를 호출한다.
 * - 그 외 상태는 외부 DB write, Upbit broker 호출, Telegram 전송을 만들지 않는다.
 */
export async function runLiveOpsLiveExecution(
  input: LiveOpsLiveExecutionInput,
): Promise<LiveOpsLiveExecutionSummary> {
  const config = loadLiveOpsConfig(input.config);
  const checks: LiveOpsLiveExecutionCheck[] = [
    okCheck("config", "production live ops live execution 설정을 확인했습니다.", "live_ops_execution_config_ok", {
      market: config.universe.default_market,
    }),
  ];

  if (!input.analysisDecision.ready) {
    // analysis가 차단 상태이면 주문 후보 배열이 들어와도 stale 후보일 수 있으므로 broker 경계를 열지 않는다.
    checks.push(blockedCheck(
      "analysis_decision",
      "analysis/decision이 준비되지 않아 live execution으로 전진하지 않습니다.",
      "live_ops_analysis_not_ready",
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "analysis/decision이 준비되지 않아 실주문 실행을 시작하지 않았습니다.",
      action: "market data, feature, strategy decision 차단 원인을 먼저 해소합니다.",
    });
  }

  checks.push(okCheck("analysis_decision", "analysis/decision summary를 확인했습니다.", "live_ops_analysis_ready", {
    decisionCategory: input.analysisDecision.decisionCategory,
    orderIntentCount: input.analysisDecision.orderIntentCount,
  }));

  if (input.analysisDecision.orderIntentCount === 0 && input.orderIntents.length === 0) {
    // HOLD tick은 정상 lifecycle이므로 broker 호출 없이 evidence-friendly idle 상태로 닫는다.
    checks.push(okCheck(
      "order_intent",
      "주문 후보가 없어 live execution broker 제출을 생략했습니다.",
      "live_ops_no_order_intent",
    ));
    return buildSummary(config, input, checks, {
      status: "idle",
      ready: true,
      liveOrderCapable: false,
      message: "주문 후보가 없어 실주문 제출은 발생하지 않았습니다.",
      action: "다음 decision tick에서 신규 후보가 생기면 예산과 reconcile freshness를 다시 확인합니다.",
    });
  }

  const orderIntentCountViolation = validateOrderIntentCount(input);
  if (orderIntentCountViolation !== undefined) {
    // summary count와 실제 후보 배열이 다르면 같은 decision tick의 후보인지 증명할 수 없어 전부 차단한다.
    checks.push(blockedCheck(
      "order_intent",
      orderIntentCountViolation.message,
      orderIntentCountViolation.code,
      orderIntentCountViolation.details,
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "live execution 후보 수가 production 실행 경계와 맞지 않아 주문을 제출하지 않았습니다.",
      action: "analysis summary와 order intent source를 같은 decision tick으로 다시 읽습니다.",
    });
  }

  const intent = input.orderIntents[0] as OrderIntent;
  const intentViolations = collectOrderIntentViolations(config, input, intent);
  if (intentViolations.length > 0) {
    // order intent 자체가 production live ops guard를 벗어나면 M22 runtime에 넘기기 전에 닫아 호출 경계를 단순하게 유지한다.
    checks.push(blockedCheck(
      "order_intent",
      "주문 후보가 production live execution guard를 통과하지 못했습니다.",
      "live_ops_order_intent_blocked",
      { violations: intentViolations },
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "주문 후보가 실운영 실행 조건을 통과하지 못해 제출하지 않았습니다.",
      action: "후보 market, 주문 유형, post-only 조건, strategy/risk scope를 확인합니다.",
    });
  }

  checks.push(okCheck("order_intent", "단일 LIMIT + post-only 주문 후보를 확인했습니다.", "live_ops_order_intent_ready", {
    market: intent.market,
    strategyId: intent.strategyId,
  }));

  const request = createLiveAutonomousEntryRequest(config, input, intent as Extract<OrderIntent, { orderType: "LIMIT" }>);
  checks.push(okCheck("execution_request", "live autonomous entry runtime 요청을 만들었습니다.", "live_ops_execution_request_ready", {
    market: request.candidate.market,
    strategyId: request.candidate.strategyId,
    hasExplicitIdempotencyKey: request.idempotencyKey !== undefined,
  }));

  let attempt: LiveAutonomousEntryAttemptResult;
  try {
    attempt = await input.entryRuntime.submitEntryCandidate(request);
  } catch (error) {
    // 하위 runtime 예외는 broker side effect 여부를 여기서 단정하지 않고 운영자 점검 상태로 격상한다.
    checks.push(blockedCheck(
      "execution_result",
      "live execution runtime 결과를 확정할 수 없어 수동 점검이 필요합니다.",
      "live_ops_execution_runtime_uncertain",
      { reason: safeErrorName(error) },
    ));
    return buildSummary(config, input, checks, {
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      latestExecutionAt: input.observedAt,
      message: "실주문 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문과 durable reservation 상태를 먼저 확인한 뒤 재시도 여부를 결정합니다.",
      trace: {
        reason: "live_ops_execution_runtime_uncertain",
        errorName: safeErrorName(error),
      },
    });
  }

  checks.push(okCheck("execution_result", "live autonomous entry runtime 결과를 확인했습니다.", "live_ops_execution_result_recorded", {
    attemptStatus: attempt.status,
  }));

  return buildSummaryFromAttempt(config, input, checks, attempt);
}

function validateOrderIntentCount(input: LiveOpsLiveExecutionInput): {
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
} | undefined {
  if (input.analysisDecision.orderIntentCount !== input.orderIntents.length) {
    return {
      code: "live_ops_order_intent_count_mismatch",
      message: "analysis summary의 주문 후보 수와 전달된 order intent 수가 다릅니다.",
      details: {
        summaryOrderIntentCount: input.analysisDecision.orderIntentCount,
        receivedOrderIntentCount: input.orderIntents.length,
      },
    };
  }

  if (input.orderIntents.length !== 1) {
    return {
      code: "live_ops_order_intent_batch_unsupported",
      message: "production live ops 첫 실행은 한 tick에 단일 주문 후보만 제출할 수 있습니다.",
      details: {
        receivedOrderIntentCount: input.orderIntents.length,
      },
    };
  }

  return undefined;
}

function collectOrderIntentViolations(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
): string[] {
  const violations: string[] = [];

  if (intent.exchangeId !== "upbit_krw_spot") {
    violations.push("exchange는 upbit_krw_spot이어야 합니다");
  }

  if (!config.universe.markets.includes(intent.market) || intent.market !== config.universe.default_market) {
    violations.push("주문 후보 market은 production live ops 기본 market이어야 합니다");
  }

  if (intent.side !== "BUY") {
    violations.push("production live ops 신규 진입은 BUY 후보만 허용합니다");
  }

  if (intent.orderType !== "LIMIT") {
    violations.push("production live ops 신규 진입은 LIMIT 주문만 허용합니다");
  } else {
    if (intent.postOnly !== true || intent.timeInForce !== "POST_ONLY") {
      violations.push("production live ops 신규 진입은 post-only LIMIT 주문만 허용합니다");
    }
  }

  if (input.risk.strategy.strategyId !== intent.strategyId) {
    violations.push("RiskGate strategy snapshot과 주문 후보 strategy가 일치해야 합니다");
  }

  if (readExpectedLossBps(intent) === undefined) {
    violations.push("주문 후보에는 RiskGate expected loss 입력이 필요합니다");
  }

  return violations;
}

function createLiveAutonomousEntryRequest(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  intent: Extract<OrderIntent, { orderType: "LIMIT" }>,
): LiveAutonomousEntryRuntimeRequest {
  const request: LiveAutonomousEntryRuntimeRequest = {
    config: createEntryRuntimeConfig(config),
    candidate: {
      exchangeId: intent.exchangeId,
      market: intent.market,
      strategyId: intent.strategyId,
      requestedQuantity: intent.requestedQuantity,
      requestedNotional: intent.requestedNotional,
      requestedPrice: intent.requestedPrice,
      referencePrice: input.referencePrice ?? intent.requestedPrice,
      reason: intent.reason,
      expectedLossBpsOfEquity: requireExpectedLossBps(intent),
      costInput: input.costInput,
      risk: input.risk,
      orderType: "LIMIT",
      postOnly: true,
      metadata: {
        ...(intent.metadata ?? {}),
        source: "live_ops_live_execution",
        decision_idempotency_key: intent.idempotencyKey,
      },
    },
    budgetSnapshot: input.budgetSnapshot,
    lossSnapshot: input.lossSnapshot,
    killSwitchActive: input.killSwitchActive,
    reconcileFresh: input.reconcileFresh,
    observedAt: input.observedAt,
  };

  if (input.idempotencyKey !== undefined) {
    request.idempotencyKey = input.idempotencyKey;
  }

  return request;
}

function createEntryRuntimeConfig(config: LiveOpsConfig): LiveAutonomousEntryRuntimeConfig {
  return {
    enabled: config.live_trading_enabled,
    allowed_markets: config.universe.markets,
    max_order_krw: config.budget.max_order_krw,
    daily_autonomous_notional_limit_krw: config.budget.daily_autonomous_notional_limit_krw,
    max_open_position_notional_krw: config.budget.max_open_position_notional_krw,
    max_daily_loss_krw: config.budget.max_order_krw,
    max_weekly_loss_krw: config.budget.daily_autonomous_notional_limit_krw,
    max_price_deviation_bps: "30",
    identifier_prefix: "ops-",
    identifier_max_length: 32,
  };
}

function readExpectedLossBps(intent: OrderIntent): string | undefined {
  const value = intent.metadata?.expected_loss_bps_of_equity ?? intent.metadata?.expectedLossBpsOfEquity;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireExpectedLossBps(intent: OrderIntent): string {
  const value = readExpectedLossBps(intent);
  if (value === undefined) {
    throw new Error("LiveOpsLiveExecutionExpectedLossMissing");
  }

  return value;
}

function buildSummaryFromAttempt(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  checks: readonly LiveOpsLiveExecutionCheck[],
  attempt: LiveAutonomousEntryAttemptResult,
): LiveOpsLiveExecutionSummary {
  const brokerOrderId = readBrokerOrderId(attempt);
  const base = {
    latestExecutionAt: input.observedAt,
    attemptStatus: attempt.status,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    brokerOrderId,
    trace: {
      reason: attempt.trace.reason,
      attemptStatus: attempt.status,
      eventCount: attempt.events.length,
    },
  };

  if (attempt.status === "SUBMITTED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "submitted",
      ready: true,
      liveOrderCapable: true,
      attemptedOrderCount: 1,
      submittedOrderCount: 1,
      message: "실주문 실행 경계가 주문 후보를 broker 제출까지 전진시켰습니다.",
      action: "체결, 취소, reconcile/PnL/status worker에서 후속 상태를 확인합니다.",
    });
  }

  if (attempt.status === "REJECTED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "rejected",
      ready: false,
      liveOrderCapable: false,
      attemptedOrderCount: 1,
      message: attempt.message,
      action: attempt.action,
    });
  }

  if (attempt.status === "MANUAL_REVIEW_REQUIRED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      attemptedOrderCount: 1,
      message: attempt.message,
      action: attempt.action,
    });
  }

  if (attempt.status === "RECONCILE_REQUIRED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "reconcile_required",
      ready: false,
      liveOrderCapable: false,
      attemptedOrderCount: 1,
      message: attempt.message,
      action: attempt.action,
    });
  }

  return buildSummary(config, input, checks, {
    ...base,
    status: "blocked",
    ready: false,
    liveOrderCapable: false,
    attemptedOrderCount: 1,
    message: attempt.message,
    action: attempt.action,
  });
}

function buildSummary(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  checks: readonly LiveOpsLiveExecutionCheck[],
  result: {
    status: LiveOpsLiveExecutionStatus;
    ready: boolean;
    liveOrderCapable: boolean;
    message: string;
    action: string;
    latestExecutionAt?: string | null;
    attemptedOrderCount?: number;
    submittedOrderCount?: number;
    attemptStatus?: string | null;
    attemptId?: string | null;
    idempotencyKey?: string | null;
    brokerOrderId?: string | null;
    trace?: JsonRecord;
  },
): LiveOpsLiveExecutionSummary {
  return {
    status: result.status,
    ready: result.ready,
    liveOrderCapable: result.liveOrderCapable,
    market: config.universe.default_market,
    observedAt: input.observedAt,
    latestExecutionAt: result.latestExecutionAt ?? null,
    orderIntentCount: input.orderIntents.length,
    attemptedOrderCount: result.attemptedOrderCount ?? 0,
    submittedOrderCount: result.submittedOrderCount ?? 0,
    attemptStatus: result.attemptStatus ?? null,
    attemptId: result.attemptId ?? null,
    idempotencyKey: result.idempotencyKey ?? null,
    brokerOrderId: result.brokerOrderId ?? null,
    message: result.message,
    action: result.action,
    checks,
    trace: {
      source: "live_ops_live_execution",
      analysisDecisionCategory: input.analysisDecision.decisionCategory,
      analysisOrderIntentCount: input.analysisDecision.orderIntentCount,
      ...(input.trace ?? {}),
      ...(result.trace ?? {}),
    },
  };
}

function readBrokerOrderId(attempt: LiveAutonomousEntryAttemptResult): string | null {
  const executionResult = attempt.executionResult;
  if (executionResult === undefined || executionResult.status === "REJECTED") {
    return null;
  }

  return executionResult.brokerOrder.brokerOrderId;
}

function okCheck(
  name: LiveOpsLiveExecutionCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsLiveExecutionCheck {
  const check: LiveOpsLiveExecutionCheck = {
    name,
    status: "ok",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function blockedCheck(
  name: LiveOpsLiveExecutionCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsLiveExecutionCheck {
  const check: LiveOpsLiveExecutionCheck = {
    name,
    status: "blocked",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
