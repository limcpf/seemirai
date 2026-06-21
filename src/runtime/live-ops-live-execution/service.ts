import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import {
  createExecutionExitCostEvidence,
  createExecutionRiskApprovalEvidence,
  evaluateRiskGate,
} from "../../application/index.js";
import type {
  ExecutionExitCostEvidence,
  ExecutionSubmitOrderResult,
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
  OrderSubmission,
  RiskGateContext,
  RiskGateResult,
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
 * live execution adapter가 호출할 하위 exit runtime port다.
 *
 * 책임:
 * - production live ops adapter가 SELL exit 후보를 ExecutionEngine 또는 후속 live-safe exit service에 전달하는 경계를 표현한다.
 * - adapter가 exit cost/risk evidence를 만든 뒤 단일 `OrderSubmission`만 넘기게 해 entry runtime과 SELL 경계를 분리한다.
 *
 * side effect:
 * - 구현체는 broker submit/cancel side effect를 만들 수 있으므로 adapter는 SELL 수량, position scope, RiskGate를 통과한 뒤에만 호출해야 한다.
 */
export interface LiveOpsLiveExecutionExitRuntime {
  submitExitOrder(submission: OrderSubmission): Promise<ExecutionSubmitOrderResult>;
}

/**
 * production live ops live execution adapter 입력 계약이다.
 *
 * 책임:
 * - analysis/decision에서 만든 BUY 후보는 기존 live autonomous entry runtime 요청으로 낮춘다.
 * - SELL 후보는 exit evidence가 포함된 `OrderSubmission`으로 낮춰 exit runtime port로 전달한다.
 * - budget, loss, cost, risk, kill switch, reconcile freshness snapshot을 같은 broker 제출 경계로 묶는다.
 *
 * 호출 경계:
 * - caller는 DB/status provider에서 최신 snapshot을 읽은 뒤 이 함수에 값으로 전달한다.
 * - 이 adapter는 BUY에서 `entryRuntime.submitEntryCandidate`, SELL에서 `exitRuntime.submitExitOrder`를 호출할 수 있다.
 *   두 호출 모두 모든 guard를 통과한 뒤에만 열린다.
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
  readonly exitRuntime?: LiveOpsLiveExecutionExitRuntime;
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
 * - 주문 후보가 정확히 1개이고 모든 adapter guard를 통과할 때만 BUY는 `entryRuntime.submitEntryCandidate`, SELL은
 *   `exitRuntime.submitExitOrder`를 호출한다.
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

  const receivedIntent = input.orderIntents[0] as OrderIntent;
  if (receivedIntent.side === "SELL") {
    return runLiveOpsExitExecution(config, input, checks, receivedIntent);
  }

  const intent = normalizeLiveOpsCleanupProbeRuntimeIntent(receivedIntent, input.observedAt);
  const intentViolations = collectEntryOrderIntentViolations(config, input, intent);
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

async function runLiveOpsExitExecution(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  checks: LiveOpsLiveExecutionCheck[],
  intent: OrderIntent,
): Promise<LiveOpsLiveExecutionSummary> {
  const executionStatusViolations = collectLiveOpsExecutionStatusViolations(input);
  if (executionStatusViolations.length > 0) {
    // SELL도 실계좌 side effect이므로 BUY runtime과 같은 운영 상태 guard를 통과해야 broker 경계가 열린다.
    checks.push(blockedCheck(
      "execution_request",
      "매도 실행 운영 상태 snapshot이 production 제출 조건을 통과하지 못했습니다.",
      "live_ops_exit_execution_status_blocked",
      { violations: executionStatusViolations },
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "매도 실행 운영 상태 증거가 부족해 SELL 후보를 제출하지 않았습니다.",
      action: "kill switch와 reconcile freshness evidence를 먼저 복구하세요.",
    });
  }

  const intentViolations = collectExitOrderIntentViolations(config, input, intent);
  if (intentViolations.length > 0) {
    // SELL 후보도 보유 수량과 exit evidence가 맞지 않으면 exit runtime 호출 전에 닫아 broker side effect를 만들지 않는다.
    checks.push(blockedCheck(
      "order_intent",
      "매도 후보가 production live exit guard를 통과하지 못했습니다.",
      "live_ops_order_intent_blocked",
      { violations: intentViolations },
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "매도 후보가 실운영 실행 조건을 통과하지 못해 제출하지 않았습니다.",
      action: "보유 수량, exit reason, position scope, post-only 조건을 확인합니다.",
    });
  }

  checks.push(okCheck("order_intent", "단일 SELL LIMIT + post-only exit 후보를 확인했습니다.", "live_ops_exit_order_intent_ready", {
    market: intent.market,
    strategyId: intent.strategyId,
  }));

  if (input.exitRuntime === undefined) {
    // SELL 실행 port가 없으면 entry runtime으로 우회하지 않고 닫아 매수/매도 책임을 섞지 않는다.
    checks.push(blockedCheck(
      "execution_request",
      "exit runtime이 조립되지 않아 매도 후보를 제출하지 않습니다.",
      "live_ops_exit_runtime_missing",
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "매도 실행 경계가 연결되지 않아 실주문 제출을 중단했습니다.",
      action: "exit runtime port와 live broker 조립 상태를 먼저 확인합니다.",
    });
  }

  const exitRequest = createExitOrderSubmission(input, intent);
  if (!exitRequest.riskGateResult.approved) {
    // RiskGate가 SELL도 허용하지 않으면 exit runtime을 호출하지 않고 operator-visible block으로 남긴다.
    checks.push(blockedCheck(
      "execution_request",
      "매도 후보가 RiskGate를 통과하지 못했습니다.",
      "live_ops_exit_risk_blocked",
      {
        action: exitRequest.riskGateResult.action,
        failed_reason_codes: exitRequest.riskGateResult.failedEvaluations.map((evaluation) => evaluation.reasonCode),
      },
    ));
    return buildSummary(config, input, checks, {
      status: "blocked",
      ready: false,
      liveOrderCapable: false,
      message: "매도 후보가 RiskGate를 통과하지 못해 제출하지 않았습니다.",
      action: "실패한 RiskGate 평가와 보유 포지션 snapshot을 확인합니다.",
    });
  }

  checks.push(okCheck("execution_request", "live autonomous exit submission을 만들었습니다.", "live_ops_exit_request_ready", {
    market: exitRequest.submission.intent.market,
    strategyId: exitRequest.submission.intent.strategyId,
    positionEffect: readStringMetadata(exitRequest.submission.intent.metadata, "position_effect"),
  }));

  let result: ExecutionSubmitOrderResult;
  try {
    result = await input.exitRuntime.submitExitOrder(exitRequest.submission);
  } catch (error) {
    // exit runtime 예외는 SELL side effect 여부가 불확실하므로 수동 reconcile 대상으로 격상한다.
    checks.push(blockedCheck(
      "execution_result",
      "exit runtime 결과를 확정할 수 없어 수동 점검이 필요합니다.",
      "live_ops_exit_runtime_uncertain",
      { reason: safeErrorName(error) },
    ));
    return buildSummary(config, input, checks, {
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      latestExecutionAt: input.observedAt,
      message: "매도 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
      action: "거래소 주문과 포지션/reconcile 상태를 먼저 확인한 뒤 재시도 여부를 결정합니다.",
      trace: {
        reason: "live_ops_exit_runtime_uncertain",
        errorName: safeErrorName(error),
      },
    });
  }

  checks.push(okCheck("execution_result", "exit runtime 결과를 확인했습니다.", "live_ops_exit_result_recorded", {
    attemptStatus: result.status,
  }));

  return buildSummaryFromExitResult(config, input, checks, result);
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

function collectLiveOpsExecutionStatusViolations(input: LiveOpsLiveExecutionInput): string[] {
  const violations: string[] = [];
  if (input.killSwitchActive !== false) {
    violations.push("kill switch가 꺼진 상태임을 확인해야 합니다");
  }
  if (input.reconcileFresh !== true) {
    violations.push("reconcile freshness가 최신 상태임을 확인해야 합니다");
  }
  return violations;
}

function collectEntryOrderIntentViolations(
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

  const referencePriceViolation = validateLiveOpsEntryReferencePrice(input.referencePrice);
  if (referencePriceViolation !== undefined) {
    violations.push(referencePriceViolation);
  }

  return violations;
}

function collectExitOrderIntentViolations(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
): string[] {
  const violations: string[] = [];

  if (intent.exchangeId !== "upbit_krw_spot") {
    violations.push("exchange는 upbit_krw_spot이어야 합니다");
  }

  if (!config.universe.markets.includes(intent.market) || intent.market !== config.universe.default_market) {
    violations.push("매도 후보 market은 production live ops 기본 market이어야 합니다");
  }

  if (intent.side !== "SELL") {
    violations.push("production live ops exit은 SELL 후보만 허용합니다");
  }

  if (intent.orderType !== "LIMIT") {
    violations.push("production live ops exit은 LIMIT 주문만 허용합니다");
  } else if (intent.postOnly !== true || intent.timeInForce !== "POST_ONLY") {
    violations.push("production live ops exit은 post-only LIMIT 주문만 허용합니다");
  }

  if (input.risk.strategy.strategyId !== intent.strategyId) {
    violations.push("RiskGate strategy snapshot과 매도 후보 strategy가 일치해야 합니다");
  }

  if (readExpectedLossBps(intent) === undefined) {
    violations.push("매도 후보에는 RiskGate expected loss 입력이 필요합니다");
  }

  const positionEffect = readStringMetadata(intent.metadata, "position_effect") ?? readStringMetadata(intent.metadata, "positionEffect");
  if (positionEffect !== "REDUCE" && positionEffect !== "EXIT") {
    violations.push("매도 후보에는 REDUCE 또는 EXIT position effect가 필요합니다");
  }

  if (readStringMetadata(intent.metadata, "exit_reason_code") === undefined) {
    violations.push("매도 후보에는 exit reason code가 필요합니다");
  }

  if (readStringMetadata(intent.metadata, "exit_rule_id") === undefined) {
    violations.push("매도 후보에는 exit rule id가 필요합니다");
  }

  const positionScope = readExitPositionScope(intent);
  if (positionScope === undefined) {
    violations.push("매도 후보에는 보유 수량 position scope가 필요합니다");
    return violations;
  }

  const quantityViolation = validateExitQuantityAgainstScope(intent, positionScope, positionEffect);
  if (quantityViolation !== undefined) {
    violations.push(quantityViolation);
  }

  const latestPositionViolation = validateExitQuantityAgainstLatestPosition(input, intent, positionScope, positionEffect);
  if (latestPositionViolation !== undefined) {
    violations.push(latestPositionViolation);
  }

  return violations;
}

const liveOpsCleanupProbeStrategyId = "live_ops_cleanup_probe";

/**
 * cleanup probe 후보의 strategy 단계 idempotency key를 runtime 제출 날짜 기준 key로 낮춘다.
 *
 * 책임:
 * - analysis pipeline이 날짜 placeholder 또는 오래된 decision key를 넘겨도 live execution reservation day와 같은 key를 사용하게 한다.
 * - 원본 analysis key는 metadata에 보존해 감사 추적성을 잃지 않는다.
 *
 * invariant:
 * - cleanup probe가 아닌 intent는 변경하지 않는다.
 * - 날짜 scope는 `observedAt`의 UTC 날짜이며, key layout은 CLI helper와 동일한
 *   `strategy:date:exchange:market:side:price:qty:notional` 순서를 유지한다.
 *
 * side effect:
 * - 없음. 입력 intent를 복사해 반환하는 순수 정규화 함수다.
 */
function normalizeLiveOpsCleanupProbeRuntimeIntent(intent: OrderIntent, observedAt: string): OrderIntent {
  if (intent.strategyId !== liveOpsCleanupProbeStrategyId) {
    return intent;
  }

  const runtimeIdempotencyKey = createLiveOpsCleanupProbeRuntimeDecisionKey(intent, observedAt);
  const dateScope = readLiveOpsRuntimeDateScope(observedAt);
  if (runtimeIdempotencyKey === undefined || dateScope === undefined) {
    return intent;
  }

  return {
    ...intent,
    idempotencyKey: runtimeIdempotencyKey,
    metadata: {
      ...(intent.metadata ?? {}),
      // runtime adapter도 CLI preflight와 같은 운영일 key를 사용해야 자정 경계 중복 reservation을 막을 수 있다.
      analysis_idempotency_key: readLiveOpsOriginalAnalysisIdempotencyKey(intent),
      idempotency_date_scope: dateScope,
      idempotency_date_source: "live_ops_runtime_preflight",
    },
  };
}

/**
 * cleanup probe runtime 정규화 이전의 analysis idempotency key를 복구한다.
 *
 * 책임:
 * - 이미 production preflight가 원본 analysis key를 보존한 intent를 다시 정규화할 때 audit 추적 키를 덮어쓰지 않는다.
 *
 * invariant:
 * - `metadata.analysis_idempotency_key`가 비어 있지 않으면 그 값을 원본으로 유지한다.
 * - 값이 없을 때만 현재 intent key를 analysis key로 사용한다.
 *
 * side effect:
 * - 없음. metadata 값을 읽어 문자열 하나만 반환한다.
 */
function readLiveOpsOriginalAnalysisIdempotencyKey(intent: OrderIntent): string {
  const existing = intent.metadata?.analysis_idempotency_key;
  return typeof existing === "string" && existing.length > 0 ? existing : intent.idempotencyKey;
}

function readOriginalDecisionIdempotencyKey(intent: OrderIntent): string {
  const existing = intent.metadata?.decision_idempotency_key;
  return typeof existing === "string" && existing.length > 0 ? existing : intent.idempotencyKey;
}

function createLiveOpsCleanupProbeRuntimeDecisionKey(intent: OrderIntent, observedAt: string): string | undefined {
  const dateScope = readLiveOpsRuntimeDateScope(observedAt);
  if (
    dateScope === undefined ||
    intent.orderType !== "LIMIT" ||
    intent.requestedPrice === undefined ||
    intent.requestedQuantity === undefined ||
    intent.requestedNotional === undefined
  ) {
    return undefined;
  }

  return [
    liveOpsCleanupProbeStrategyId,
    dateScope,
    intent.exchangeId,
    intent.market,
    intent.side,
    intent.requestedPrice,
    intent.requestedQuantity,
    intent.requestedNotional,
  ].join(":");
}

function readLiveOpsRuntimeDateScope(observedAt: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}/u.test(observedAt) ? observedAt.slice(0, 10) : undefined;
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
      referencePrice: requireLiveOpsEntryReferencePrice(input),
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
    // decision key를 그대로 live broker identifier로 쓰지 않고 Upbit 허용 길이의 stable attempt id로 낮춰 재시작 중복 제출을 막는다.
    idempotencyKey: createStableLiveOpsAttemptId(input, intent),
    observedAt: input.observedAt,
  };

  return request;
}

/**
 * live execution adapter가 사용할 Upbit-safe attempt id를 결정한다.
 *
 * 책임:
 * - caller가 명시한 `ops-` identifier는 그대로 보존한다.
 * - strategy가 만든 긴 decision key는 deterministic hash로 낮춰 같은 후보가 재평가되어도 같은 runtime attempt id를 쓰게 한다.
 *
 * side effect:
 * - 없음. 순수 문자열 정규화이며 DB, broker, Telegram을 호출하지 않는다.
 */
function createStableLiveOpsAttemptId(
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
): string {
  const candidate = input.idempotencyKey ?? intent.idempotencyKey;
  if (isLiveOpsAttemptId(candidate)) {
    return candidate;
  }

  const source = candidate.trim().length > 0 ? candidate : "missing-live-ops-decision-key";
  return `ops-${createHash("sha256").update(source).digest("hex").slice(0, 26)}`;
}

function isLiveOpsAttemptId(value: string): boolean {
  return /^ops-[a-f0-9]{26}$/u.test(value);
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

function createExitOrderSubmission(
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
): {
  readonly submission: OrderSubmission;
  readonly riskGateResult: RiskGateResult;
} {
  const expectedLossBpsOfEquity = requireExpectedLossBps(intent);
  const positionScope = requireExitPositionScope(intent);
  const runtimeIntent = normalizeLiveOpsExitRuntimeIntent(input, intent);
  const riskContext = createExitRiskContext(input, runtimeIntent, expectedLossBpsOfEquity);
  const riskGateResult = evaluateRiskGate(riskContext);
  const submission: OrderSubmission = {
    intent: runtimeIntent,
    costSnapshot: createExecutionExitCostEvidence({
      intent: runtimeIntent,
      positionScope,
      exitCostBps: readStringMetadata(runtimeIntent.metadata, "exit_cost_bps") ?? "0",
      exitSlippageBps: readStringMetadata(runtimeIntent.metadata, "exit_slippage_bps") ?? "0",
      expectedLossBpsOfEquity,
    }),
    riskApproval: createExecutionRiskApprovalEvidence(riskGateResult, riskContext),
    expectedLossBpsOfEquity,
    submittedAt: input.observedAt,
  };

  return {
    submission,
    riskGateResult,
  };
}

/**
 * SELL exit 후보의 strategy decision key를 live broker identifier로 사용할 수 있는 runtime key로 낮춘다.
 *
 * 책임:
 * - autonomous strategy가 만든 긴 decision fingerprint를 Upbit identifier 제한에 맞는 `ops-` attempt id로 변환한다.
 * - 원본 decision key는 metadata에 보존해 strategy 판단 재현과 duplicate order 추적을 유지한다.
 *
 * side effect:
 * - 없음. OrderIntent 값을 복사해 broker 제출 전 순수 정규화만 수행한다.
 */
function normalizeLiveOpsExitRuntimeIntent(input: LiveOpsLiveExecutionInput, intent: OrderIntent): OrderIntent {
  const runtimeIdempotencyKey = createStableLiveOpsAttemptId(input, intent);
  const originalDecisionKey = readOriginalDecisionIdempotencyKey(intent);

  return {
    ...intent,
    idempotencyKey: runtimeIdempotencyKey,
    metadata: {
      ...(intent.metadata ?? {}),
      // SELL도 BUY와 동일하게 broker identifier와 strategy decision key를 분리해 Upbit identifier 길이 제한을 넘지 않게 한다.
      decision_idempotency_key: originalDecisionKey,
      runtime_idempotency_source: "live_ops_live_execution_exit",
    },
  };
}

/**
 * SELL exit 후보의 RiskGate context를 만든다.
 *
 * 책임:
 * - entry runtime을 거치지 않는 SELL도 같은 RiskGate evidence factory를 사용하게 한다.
 * - caller가 전달한 최신 account/position/strategy/infrastructure snapshot과 현재 intent fingerprint를 묶는다.
 *
 * side effect:
 * - 없음. 순수 context 생성이며 DB/provider 조회를 수행하지 않는다.
 */
function createExitRiskContext(
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
  expectedLossBpsOfEquity: string,
): RiskGateContext {
  return {
    orderIntent: intent,
    account: input.risk.account,
    positions: input.risk.positions,
    strategy: input.risk.strategy,
    infrastructureSignals: input.risk.infrastructureSignals,
    thresholdSnapshot: input.risk.thresholdSnapshot,
    observedAt: input.observedAt,
    expectedLossBpsOfEquity,
    metadata: {
      ...(input.risk.metadata ?? {}),
      source: "live_ops_live_execution_exit",
    },
  };
}

/**
 * exit runtime 결과를 live ops safe summary로 낮춘다.
 *
 * invariant:
 * - `REJECTED`는 broker side effect 없음으로 보고 rejected summary로 닫는다.
 * - `DUPLICATE_SUPPRESSED`는 새 broker 제출은 아니지만 같은 주문 lifecycle을 공유하므로 submitted 계열 summary로 보존한다.
 */
function buildSummaryFromExitResult(
  config: LiveOpsConfig,
  input: LiveOpsLiveExecutionInput,
  checks: readonly LiveOpsLiveExecutionCheck[],
  result: ExecutionSubmitOrderResult,
): LiveOpsLiveExecutionSummary {
  const base = {
    latestExecutionAt: input.observedAt,
    attemptStatus: result.status,
    attemptId: result.submission.intent.idempotencyKey,
    idempotencyKey: result.submission.intent.idempotencyKey,
    brokerOrderId: result.status === "REJECTED" ? null : result.brokerOrder.brokerOrderId,
    trace: {
      reason: result.status === "REJECTED" ? result.rejection.reasonCode : "exit_order_submitted",
      attemptStatus: result.status,
      side: result.submission.intent.side,
    },
  };

  if (result.status === "SUBMITTED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "submitted",
      ready: true,
      liveOrderCapable: true,
      attemptedOrderCount: 1,
      submittedOrderCount: 1,
      message: "매도 실행 경계가 SELL 후보를 broker 제출까지 전진시켰습니다.",
      action: "체결, 취소, reconcile/PnL/status worker에서 포지션 종료 상태를 확인합니다.",
    });
  }

  if (result.status === "DUPLICATE_SUPPRESSED") {
    return buildSummary(config, input, checks, {
      ...base,
      status: "submitted",
      ready: true,
      liveOrderCapable: true,
      attemptedOrderCount: 1,
      submittedOrderCount: 0,
      message: "동일 매도 후보가 이미 실행 중이라 중복 broker 제출을 억제했습니다.",
      action: "기존 주문의 체결, 취소, reconcile 상태를 확인합니다.",
    });
  }

  return buildSummary(config, input, checks, {
    ...base,
    status: "rejected",
    ready: false,
    liveOrderCapable: false,
    attemptedOrderCount: 1,
    message: result.rejection.message,
    action: "ExecutionEngine 거부 사유를 확인하고 같은 후보를 재제출하지 않습니다.",
  });
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

function readExitPositionScope(intent: OrderIntent): ExecutionExitCostEvidence["position_scope"] | undefined {
  const scope = intent.metadata?.position_scope;
  if (!isNonEmptyRecord(scope)) {
    return undefined;
  }

  if (
    typeof scope.market !== "string" ||
    typeof scope.strategy_id !== "string" ||
    typeof scope.total_quantity !== "string"
  ) {
    return undefined;
  }

  return {
    market: scope.market,
    strategy_id: scope.strategy_id,
    total_quantity: scope.total_quantity,
  };
}

function requireExitPositionScope(intent: OrderIntent): ExecutionExitCostEvidence["position_scope"] {
  const scope = readExitPositionScope(intent);
  if (scope === undefined) {
    throw new Error("LiveOpsLiveExecutionExitPositionScopeMissing");
  }

  return scope;
}

function validateExitQuantityAgainstScope(
  intent: OrderIntent,
  positionScope: ExecutionExitCostEvidence["position_scope"],
  positionEffect: string | undefined,
): string | undefined {
  try {
    const requestedQuantity = new Decimal(intent.requestedQuantity);
    const openQuantity = new Decimal(positionScope.total_quantity);

    if (!openQuantity.gt(0)) {
      return "매도 후보의 보유 수량 scope는 0보다 커야 합니다";
    }

    if (requestedQuantity.gt(openQuantity)) {
      return "매도 후보 수량은 보유 수량을 초과할 수 없습니다";
    }

    if (positionEffect === "EXIT" && !requestedQuantity.eq(openQuantity)) {
      return "EXIT 매도 후보 수량은 보유 수량 전체와 일치해야 합니다";
    }
  } catch {
    return "매도 후보 수량과 보유 수량은 Decimal 문자열이어야 합니다";
  }

  return undefined;
}

/**
 * BUY entry adapter가 fresh market reference를 갖고 있는지 검증한다.
 *
 * 책임:
 * - adapter 호출자가 기준가를 누락했을 때 요청가를 기준가로 보정해 가격 이탈 검증을 무력화하지 못하게 한다.
 * - 반환 문자열은 broker side effect 전에 사용자-visible block reason으로 내려갈 수 있는 secret-safe 문장이다.
 *
 * side effect:
 * - 없음. 문자열과 Decimal 파싱만 수행한다.
 */
function validateLiveOpsEntryReferencePrice(referencePrice: string | undefined): string | undefined {
  const parsed = readPositiveDecimal(referencePrice);
  if (parsed === undefined) {
    return "BUY 후보에는 fresh reference price evidence가 필요하며 요청가로 보정하지 않습니다";
  }

  return undefined;
}

/**
 * entry runtime request에 전달할 검증된 reference price를 반환한다.
 *
 * 책임:
 * - 앞선 guard를 통과한 입력만 하위 runtime request로 낮춘다는 invariant를 타입 수준에서 보조한다.
 * - invariant가 깨진 내부 호출은 예외로 드러내되, 정상 경로에서는 broker/API side effect를 만들지 않는다.
 *
 * side effect:
 * - 없음. 입력 snapshot만 읽는다.
 */
function requireLiveOpsEntryReferencePrice(input: LiveOpsLiveExecutionInput): string {
  const referencePrice = input.referencePrice?.trim();
  if (referencePrice === undefined || readPositiveDecimal(referencePrice) === undefined) {
    throw new Error("LiveOpsLiveExecutionReferencePriceMissing");
  }

  return referencePrice;
}

/**
 * SELL exit 후보의 scope가 제출 직전 최신 position snapshot과 일치하는지 검증한다.
 *
 * 책임:
 * - analysis 시점 position scope만 믿고 stale SELL이 broker까지 가는 것을 막는다.
 * - 명시적 strategy-owned position snapshot만 제출 직전 근거로 보고, requested quantity와 metadata scope를 함께 대조한다.
 *
 * invariant:
 * - matching position은 exchange/market/strategy가 모두 같아야 한다.
 * - REDUCE는 최신 수량 이하만 허용하고, EXIT는 최신 전체 수량과 정확히 일치해야 한다.
 *
 * side effect:
 * - 없음. Risk snapshot과 intent metadata만 읽는다.
 */
function validateExitQuantityAgainstLatestPosition(
  input: LiveOpsLiveExecutionInput,
  intent: OrderIntent,
  positionScope: ExecutionExitCostEvidence["position_scope"],
  positionEffect: string | undefined,
): string | undefined {
  const latestPosition = input.risk.positions.find((position) => isMatchingExitPositionSnapshot(position, intent, positionScope));
  const latestQuantity = readPositionRiskSnapshotQuantity(latestPosition);
  if (latestQuantity === undefined) {
    return "매도 후보에는 최신 포지션 snapshot의 strategy-owned 수량 evidence가 필요합니다";
  }

  try {
    const requestedQuantity = new Decimal(intent.requestedQuantity);
    const scopedQuantity = new Decimal(positionScope.total_quantity);

    if (!latestQuantity.gt(0)) {
      return "최신 포지션 snapshot 수량은 0보다 커야 SELL 후보를 제출할 수 있습니다";
    }

    if (!scopedQuantity.eq(latestQuantity)) {
      return "매도 후보 position scope가 최신 포지션 snapshot 수량과 일치해야 합니다";
    }

    if (requestedQuantity.gt(latestQuantity)) {
      return "매도 후보 수량은 최신 포지션 snapshot 수량을 초과할 수 없습니다";
    }

    if (positionEffect === "EXIT" && !requestedQuantity.eq(latestQuantity)) {
      return "EXIT 매도 후보 수량은 최신 포지션 snapshot 전체 수량과 일치해야 합니다";
    }
  } catch {
    return "최신 포지션 snapshot 수량과 매도 후보 수량은 Decimal 문자열이어야 합니다";
  }

  return undefined;
}

/**
 * 최신 SELL position snapshot이 특정 strategy 소유 근거인지 판정한다.
 *
 * 책임:
 * - `strategyId`가 없는 aggregate/account snapshot을 현재 strategy snapshot으로 암묵 변환하지 않는다.
 * - exchange, market, strategy가 모두 명시적으로 일치할 때만 SELL 수량 재검증 근거로 사용한다.
 *
 * side effect:
 * - 없음. snapshot과 intent 값을 비교만 한다.
 */
function isMatchingExitPositionSnapshot(
  position: LiveOpsLiveExecutionInput["risk"]["positions"][number],
  intent: OrderIntent,
  positionScope: ExecutionExitCostEvidence["position_scope"],
): boolean {
  return (
    position.exchangeId === intent.exchangeId &&
    position.market === positionScope.market &&
    position.strategyId === positionScope.strategy_id
  );
}

/**
 * RiskGate position snapshot metadata에서 strategy-owned 수량 evidence를 읽는다.
 *
 * 책임:
 * - 여러 caller가 사용하는 수량 key alias를 같은 우선순위로 정규화한다.
 * - 수량이 없거나 0 이하, Decimal 파싱 불가이면 제출 가능 수량으로 보지 않는다.
 *
 * side effect:
 * - 없음. metadata 조회와 Decimal 파싱만 수행한다.
 */
function readPositionRiskSnapshotQuantity(
  position: LiveOpsLiveExecutionInput["risk"]["positions"][number] | undefined,
): Decimal | undefined {
  if (position === undefined) {
    return undefined;
  }
  const quantity =
    readStringMetadata(position.metadata, "strategy_owned_quantity") ??
    (position.strategyId === undefined
      ? undefined
      : readStringMetadata(position.metadata, "position_quantity") ??
        readStringMetadata(position.metadata, "position_total_quantity") ??
        readStringMetadata(position.metadata, "total_quantity") ??
        readStringMetadata(position.metadata, "quantity"));
  return readPositiveDecimal(quantity);
}

/**
 * 양수 Decimal 문자열만 내부 계산값으로 낮춘다.
 *
 * 책임:
 * - guard helper들이 빈 문자열, 0 이하, malformed numeric input을 동일하게 결측 evidence로 다루게 한다.
 *
 * side effect:
 * - 없음.
 */
function readPositiveDecimal(value: string | undefined): Decimal | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed = new Decimal(value);
    return parsed.gt(0) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readStringMetadata(metadata: JsonRecord | undefined, key: string): string | undefined {
  const value = metadata?.[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNonEmptyRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
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
