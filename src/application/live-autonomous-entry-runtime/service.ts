import { Decimal } from "decimal.js";
import {
  CostModel,
  createLiveAutonomousOrderAttemptEvent,
} from "../../domain/index.js";
import type {
  CostDecision,
  CostModelInput,
  JsonRecord,
  LiveAutonomousOrderAttemptEvent,
  LiveAutonomousOrderAttemptStatus,
  OrderIntent,
  OrderSubmission,
  RiskGateContext,
  RiskGateResult,
  TimestampInput,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  createExecutionCostSnapshotEvidence,
  createExecutionRiskApprovalEvidence,
} from "../execution/index.js";
import { evaluateRiskGate as evaluateRiskGateDefault } from "../risk/index.js";
import {
  UnsafeLiveAutonomousIdentifierError,
  createLiveAutonomousIdentifier,
  validateLiveAutonomousIdentifier,
} from "./identifier.js";
import type {
  LiveAutonomousBudgetReservation,
  LiveAutonomousEntryAttemptResult,
  LiveAutonomousEntryCandidate,
  LiveAutonomousEntryRuntimePorts,
  LiveAutonomousEntryRuntimeRequest,
} from "./types.js";

/**
 * M22 autonomous entry preflight violation이다.
 *
 * 후보를 broker 제출까지 전진시키지 않을 때 사용할 최종 상태, 사용자-facing message/action, 내부 reason code를 한 묶음으로
 * 유지한다. 이 값은 순수 판단 결과이며 budget reservation이나 broker side effect를 만들지 않는다.
 */
interface RuntimeViolation {
  status: Extract<LiveAutonomousOrderAttemptStatus, "BLOCKED" | "RECONCILE_REQUIRED" | "MANUAL_REVIEW_REQUIRED">;
  reasonCode: string;
  message: string;
  action: string;
  metadata?: JsonRecord;
}

const upbitKrwMinimumOrderNotional = new Decimal(5_000);

/**
 * M22 제한적 완전 자동매매 entry runtime service다.
 *
 * 이 서비스는 단일 BUY 후보를 `LIMIT + POST_ONLY` intent로 승격한 뒤 비용, RiskGate, kill switch, reconcile freshness, budget
 * reservation을 순서대로 재검증한다. Upbit private client를 직접 만들지 않고, 모든 주문 side effect는 주입된 `ExecutionEngine`의
 * `submitOrder` 경계에서만 발생한다.
 */
export class LiveAutonomousEntryRuntime {
  private readonly executionEngine: LiveAutonomousEntryRuntimePorts["executionEngine"];
  private readonly budgetReservation: LiveAutonomousEntryRuntimePorts["budgetReservation"];
  private readonly costModel: Pick<CostModel, "evaluate">;
  private readonly evaluateRiskGate: (context: RiskGateContext) => RiskGateResult;
  private readonly randomHex: LiveAutonomousEntryRuntimePorts["randomHex"];
  private readonly clock: () => TimestampInput;

  public constructor(ports: LiveAutonomousEntryRuntimePorts) {
    this.executionEngine = ports.executionEngine;
    this.budgetReservation = ports.budgetReservation;
    this.costModel = ports.costModel ?? new CostModel();
    this.evaluateRiskGate = ports.evaluateRiskGate ?? evaluateRiskGateDefault;
    this.randomHex = ports.randomHex;
    this.clock = ports.clock ?? (() => new Date().toISOString());
  }

  /**
   * 단일 autonomous entry 후보를 검증하고, 통과한 경우에만 ExecutionEngine으로 제출한다.
   *
   * budget reservation은 비용/RiskGate 승인 뒤, broker 제출 직전에 수행한다. ExecutionEngine이 broker 호출 전 거부한 경우에만
   * reservation release를 시도하고, broker 예외처럼 side effect 여부가 불명확한 경우에는 수동 점검 상태로 남긴다.
   */
  public async submitEntryCandidate(
    request: LiveAutonomousEntryRuntimeRequest,
  ): Promise<LiveAutonomousEntryAttemptResult> {
    const observedAt = request.observedAt ?? this.clock();
    const idempotencyKey = resolveEntryIdempotencyKey(request, this.randomHex);
    const events: LiveAutonomousOrderAttemptEvent[] = [];
    let currentStatus: LiveAutonomousOrderAttemptStatus | undefined;

    const appendEvent = (
      toStatus: LiveAutonomousOrderAttemptStatus,
      reasonCode: string,
      message: string,
      action: string,
      metadata?: JsonRecord,
    ): void => {
      const eventInput: Parameters<typeof createLiveAutonomousOrderAttemptEvent>[0] = {
        attemptId: idempotencyKey,
        toStatus,
        reasonCode,
        message,
        action,
        observedAt,
      };
      if (currentStatus !== undefined) {
        eventInput.fromStatus = currentStatus;
      }
      if (metadata !== undefined) {
        eventInput.metadata = metadata;
      }

      const event = createLiveAutonomousOrderAttemptEvent(eventInput);
      events.push(event);
      currentStatus = toStatus;
    };

    appendEvent(
      "CANDIDATE_CREATED",
      "candidate_created",
      "M22 자동매매 주문 후보가 생성됐습니다.",
      "비용, 리스크, 예산, reconcile 상태를 순서대로 다시 확인합니다.",
      {
        market: request.candidate.market,
        strategy_id: request.candidate.strategyId,
      },
    );

    const intent = createEntryIntent(request.candidate, idempotencyKey);
    const preflightViolations = collectPreflightViolations(request, intent);
    const preflightViolation = preflightViolations[0];
    if (preflightViolation !== undefined) {
      appendEvent(
        preflightViolation.status,
        preflightViolation.reasonCode,
        preflightViolation.message,
        preflightViolation.action,
        preflightViolation.metadata,
      );
      return createResult({
        request,
        idempotencyKey,
        status: preflightViolation.status,
        message: preflightViolation.message,
        action: preflightViolation.action,
        violations: preflightViolations.map((violation) => violation.message),
        events,
        intent,
        trace: {
          reason: preflightViolation.reasonCode,
          violation_reason_codes: preflightViolations.map((violation) => violation.reasonCode),
        },
      });
    }

    const costDecision = this.costModel.evaluate(createCostInput(request.candidate, intent, observedAt));
    if (!costDecision.tradeAllowed) {
      appendEvent(
        "BLOCKED",
        costDecision.reasonCode,
        "M22 자동매매 주문 후보가 비용 조건을 통과하지 못했습니다.",
        "비용 입력과 기대 수익률을 확인한 뒤 새 후보를 생성합니다.",
        {
          cost_reason_code: costDecision.reasonCode,
        },
      );
      return createResult({
        request,
        idempotencyKey,
        status: "BLOCKED",
        message: "M22 자동매매 주문 후보가 비용 조건을 통과하지 못했습니다.",
        action: "비용 입력과 기대 수익률을 확인한 뒤 새 후보를 생성합니다.",
        violations: [costDecision.message],
        events,
        intent,
        costDecision,
        trace: {
          reason: costDecision.reasonCode,
        },
      });
    }

    appendEvent(
      "COST_APPROVED",
      "cost_approved",
      "M22 자동매매 주문 후보가 비용 조건을 통과했습니다.",
      "RiskGate와 예산 선점을 계속 확인합니다.",
      {
        cost_reason_code: costDecision.reasonCode,
      },
    );

    const riskContext = createRiskContext(request.candidate, intent, observedAt);
    const riskGateResult = this.evaluateRiskGate(riskContext);
    if (!riskGateResult.approved) {
      appendEvent(
        "BLOCKED",
        "risk_gate_blocked",
        "M22 자동매매 주문 후보가 RiskGate를 통과하지 못했습니다.",
        "실패한 RiskGate 평가를 확인하고 자동 주문을 재시도하지 않습니다.",
        {
          action: riskGateResult.action,
          failed_reason_codes: riskGateResult.failedEvaluations.map((evaluation) => evaluation.reasonCode),
        },
      );
      return createResult({
        request,
        idempotencyKey,
        status: "BLOCKED",
        message: "M22 자동매매 주문 후보가 RiskGate를 통과하지 못했습니다.",
        action: "실패한 RiskGate 평가를 확인하고 자동 주문을 재시도하지 않습니다.",
        violations: riskGateResult.failedEvaluations.map((evaluation) => evaluation.message),
        events,
        intent,
        costDecision,
        riskGateResult,
        trace: {
          reason: "risk_gate_blocked",
          action: riskGateResult.action,
        },
      });
    }

    appendEvent(
      "RISK_APPROVED",
      "risk_approved",
      "M22 자동매매 주문 후보가 RiskGate를 통과했습니다.",
      "durable budget reservation을 만든 뒤 broker 제출 직전 검증을 계속합니다.",
      {
        risk_status: riskGateResult.status,
        risk_action: riskGateResult.action,
      },
    );

    let reservationResult: Awaited<ReturnType<LiveAutonomousEntryRuntimePorts["budgetReservation"]["reserve"]>>;
    try {
      reservationResult = await this.budgetReservation.reserve({
        attemptId: idempotencyKey,
        idempotencyKey,
        market: intent.market,
        strategyId: intent.strategyId,
        requestedNotionalKrw: intent.requestedNotional,
        budgetSnapshot: request.budgetSnapshot,
        observedAt,
        metadata: {
          source: "live_autonomous_entry_runtime",
        },
      });
    } catch (error) {
      appendEvent(
        "MANUAL_REVIEW_REQUIRED",
        "budget_reservation_unavailable",
        "M22 자동매매 예산 선점 저장 결과를 확정할 수 없어 주문을 제출하지 않았습니다.",
        "broker side effect는 없으므로 durable reservation store 상태를 복구한 뒤 새 후보 또는 기존 attempt를 점검합니다.",
        {
          error_message: error instanceof Error ? error.message : String(error),
        },
      );
      return createResult({
        request,
        idempotencyKey,
        status: "MANUAL_REVIEW_REQUIRED",
        message: "M22 자동매매 예산 선점 저장 결과를 확정할 수 없어 주문을 제출하지 않았습니다.",
        action: "broker side effect는 없으므로 durable reservation store 상태를 복구한 뒤 새 후보 또는 기존 attempt를 점검합니다.",
        violations: [error instanceof Error ? error.message : String(error)],
        events,
        intent,
        costDecision,
        riskGateResult,
        trace: {
          reason: "budget_reservation_unavailable",
        },
      });
    }
    if (!reservationResult.reserved) {
      appendEvent(
        "BLOCKED",
        reservationResult.reasonCode,
        "M22 자동매매 예산 선점이 거부되어 주문을 제출하지 않았습니다.",
        "최신 예산 사용량과 open position notional을 확인합니다.",
        reservationResult.metadata,
      );
      return createResult({
        request,
        idempotencyKey,
        status: "BLOCKED",
        message: "M22 자동매매 예산 선점이 거부되어 주문을 제출하지 않았습니다.",
        action: "최신 예산 사용량과 open position notional을 확인합니다.",
        violations: [reservationResult.message],
        events,
        intent,
        costDecision,
        riskGateResult,
        trace: {
          reason: reservationResult.reasonCode,
        },
      });
    }

    const reservation = reservationResult.reservation;
    appendEvent(
      "RESERVED",
      "budget_reserved",
      "M22 자동매매 예산이 durable reservation으로 선점됐습니다.",
      "같은 identifier로 ExecutionEngine 제출을 진행합니다.",
      {
        reservation_id: reservation.reservationId,
      },
    );

    const submission = createSubmission(intent, costDecision, riskContext, riskGateResult, observedAt);
    try {
      const executionResult = await this.executionEngine.submitOrder(submission);
      if (executionResult.status === "REJECTED") {
        await this.releaseReservationAfterPreBrokerRejection(reservation, executionResult.rejection.reasonCode);
        appendEvent(
          "REJECTED",
          executionResult.rejection.reasonCode,
          "ExecutionEngine이 broker 제출 전에 M22 자동매매 주문을 거부했습니다.",
          "거부 사유를 확인하고 같은 identifier를 재사용하지 않습니다.",
          executionResult.rejection.metadata,
        );
        return createResult({
          request,
          idempotencyKey,
          status: "REJECTED",
          message: "ExecutionEngine이 broker 제출 전에 M22 자동매매 주문을 거부했습니다.",
          action: "거부 사유를 확인하고 같은 identifier를 재사용하지 않습니다.",
          violations: [executionResult.rejection.message],
          events,
          intent,
          costDecision,
          riskGateResult,
          budgetReservation: reservation,
          submission,
          executionResult,
          trace: {
            reason: executionResult.rejection.reasonCode,
          },
        });
      }

      appendEvent(
        "SUBMITTED",
        executionResult.status === "SUBMITTED" ? "broker_submitted" : "duplicate_suppressed",
        "M22 자동매매 주문이 ExecutionEngine 경계를 통과했습니다.",
        "체결, 부분 체결, 취소, reconcile 상태는 후속 exit/status runtime에서 추적합니다.",
        {
          broker_order_id: executionResult.brokerOrder.brokerOrderId,
          execution_status: executionResult.status,
        },
      );
      return createResult({
        request,
        idempotencyKey,
        status: "SUBMITTED",
        message: "M22 자동매매 주문이 ExecutionEngine 경계를 통과했습니다.",
        action: "체결, 부분 체결, 취소, reconcile 상태는 후속 exit/status runtime에서 추적합니다.",
        violations: [],
        events,
        intent,
        costDecision,
        riskGateResult,
        budgetReservation: reservation,
        submission,
        executionResult,
        trace: {
          reason: executionResult.status === "SUBMITTED" ? "broker_submitted" : "duplicate_suppressed",
        },
      });
    } catch (error) {
      appendEvent(
        "MANUAL_REVIEW_REQUIRED",
        "broker_submission_uncertain",
        "broker 제출 결과를 확정할 수 없어 M22 자동매매 주문을 수동 점검 상태로 남겼습니다.",
        "예산 선점을 해제하지 말고 거래소 주문 상태와 reconcile 결과를 먼저 확인합니다.",
        {
          error_message: error instanceof Error ? error.message : String(error),
          reservation_id: reservation.reservationId,
        },
      );
      return createResult({
        request,
        idempotencyKey,
        status: "MANUAL_REVIEW_REQUIRED",
        message: "broker 제출 결과를 확정할 수 없어 M22 자동매매 주문을 수동 점검 상태로 남겼습니다.",
        action: "예산 선점을 해제하지 말고 거래소 주문 상태와 reconcile 결과를 먼저 확인합니다.",
        violations: [error instanceof Error ? error.message : String(error)],
        events,
        intent,
        costDecision,
        riskGateResult,
        budgetReservation: reservation,
        submission,
        trace: {
          reason: "broker_submission_uncertain",
        },
      });
    }
  }

  private async releaseReservationAfterPreBrokerRejection(
    reservation: LiveAutonomousBudgetReservation,
    reasonCode: string,
  ): Promise<void> {
    if (this.budgetReservation.release === undefined) {
      return;
    }

    // ExecutionEngine `REJECTED`는 broker side effect가 없다는 뜻이므로 이 경우에만 예산 선점을 해제한다.
    await this.budgetReservation.release(reservation, reasonCode);
  }
}

/**
 * M22 entry 후보가 비용/RiskGate 단계로 전진할 수 있는지 사전 위반을 수집한다.
 *
 * disabled config, market allowlist, kill switch, reconcile freshness, order type, 예산, 가격 이탈을 모두 reservation 이전에
 * 평가한다. 여러 위반을 함께 반환해 status/report에서 운영자가 한 번에 조치할 수 있게 한다.
 */
function collectPreflightViolations(
  request: LiveAutonomousEntryRuntimeRequest,
  intent: OrderIntent,
): RuntimeViolation[] {
  const violations: RuntimeViolation[] = [];
  const candidate = request.candidate;
  const requestedOrderType = candidate.orderType ?? "LIMIT";
  const postOnly = candidate.postOnly ?? true;

  if (!request.config.enabled) {
    violations.push(blocked("live_autonomous_disabled", "M22 자동매매 설정이 비활성이라 주문 후보를 제출하지 않습니다."));
  }

  if (!request.config.allowed_markets.includes(candidate.market)) {
    violations.push(blocked("market_not_allowed", "M22 자동매매 허용 market이 아니라 주문 후보를 제출하지 않습니다.", {
      market: candidate.market,
    }));
  }

  if (request.killSwitchActive) {
    violations.push(blocked("kill_switch_active", "kill switch가 활성화되어 M22 자동매매 주문 후보를 제출하지 않습니다."));
  }

  if (!request.reconcileFresh) {
    violations.push({
      status: "RECONCILE_REQUIRED",
      reasonCode: "reconcile_stale",
      message: "최신 reconcile 상태가 없어 M22 자동매매 주문 후보를 제출하지 않습니다.",
      action: "거래소 open order와 local 상태를 reconcile 한 뒤 새 후보를 평가합니다.",
    });
  }

  if (requestedOrderType !== "LIMIT" || !postOnly) {
    violations.push(blocked("limit_post_only_required", "M22 자동매매는 LIMIT + post_only 주문만 제출할 수 있습니다.", {
      requested_order_type: requestedOrderType,
      post_only: postOnly,
    }));
  }

  appendAmountAndBudgetViolations(violations, request, intent);
  appendLossLimitViolations(violations, request);
  appendPriceDeviationViolations(violations, request);

  return violations;
}

/**
 * M22 entry 후보의 금액과 예산 한도 위반을 수집한다.
 *
 * config limit과 budget snapshot limit 중 더 낮은 값을 적용해 stale snapshot이나 완화된 adapter 입력이 소액 pilot 한도를 넓히지
 * 못하게 한다. 이 함수는 순수 검증이며 reservation write나 broker side effect를 만들지 않는다.
 */
function appendAmountAndBudgetViolations(
  violations: RuntimeViolation[],
  request: LiveAutonomousEntryRuntimeRequest,
  intent: OrderIntent,
): void {
  const requestedNotional = parsePositiveDecimal(intent.requestedNotional, "requested_notional", violations);
  const requestedQuantity = parsePositiveDecimal(intent.requestedQuantity, "requested_quantity", violations);
  const requestedPrice = parsePositiveDecimal(
    intent.orderType === "LIMIT" ? intent.requestedPrice : "",
    "requested_price",
    violations,
  );
  const dailyUsed = parseNonNegativeDecimal(
    request.budgetSnapshot.dailyAutonomousNotionalUsedKrw,
    "daily_autonomous_notional_used_krw",
    violations,
  );
  const maxOrder = parsePositiveDecimal(request.config.max_order_krw, "max_order_krw", violations);
  const snapshotMaxOrder = parsePositiveDecimal(
    request.budgetSnapshot.maxOrderKrw,
    "budget_snapshot_max_order_krw",
    violations,
  );
  const dailyLimit = parsePositiveDecimal(
    request.config.daily_autonomous_notional_limit_krw,
    "daily_autonomous_notional_limit_krw",
    violations,
  );
  const snapshotDailyLimit = parsePositiveDecimal(
    request.budgetSnapshot.dailyAutonomousNotionalLimitKrw,
    "budget_snapshot_daily_autonomous_notional_limit_krw",
    violations,
  );
  const maxOpenPosition = parsePositiveDecimal(
    request.config.max_open_position_notional_krw,
    "max_open_position_notional_krw",
    violations,
  );
  const snapshotMaxOpenPosition = parsePositiveDecimal(
    request.budgetSnapshot.maxOpenPositionNotionalKrw,
    "budget_snapshot_max_open_position_notional_krw",
    violations,
  );
  const currentOpenPosition = parseNonNegativeDecimal(
    request.budgetSnapshot.openPositionNotionalKrw,
    "budget_snapshot_open_position_notional_krw",
    violations,
  );

  if (
    requestedNotional === undefined ||
    requestedQuantity === undefined ||
    requestedPrice === undefined ||
    dailyUsed === undefined ||
    maxOrder === undefined ||
    snapshotMaxOrder === undefined ||
    dailyLimit === undefined ||
    snapshotDailyLimit === undefined ||
    maxOpenPosition === undefined ||
    snapshotMaxOpenPosition === undefined ||
    currentOpenPosition === undefined
  ) {
    return;
  }

  // snapshot limit이 config보다 완화되어 들어와도 소액 pilot 경계를 넓히지 않도록 더 낮은 한도를 적용한다.
  const actualLimitNotional = requestedQuantity.mul(requestedPrice);
  const effectiveMaxOrder = Decimal.min(maxOrder, snapshotMaxOrder);
  const effectiveDailyLimit = Decimal.min(dailyLimit, snapshotDailyLimit);
  const effectiveMaxOpenPosition = Decimal.min(maxOpenPosition, snapshotMaxOpenPosition);

  if (!actualLimitNotional.equals(requestedNotional)) {
    violations.push(blocked("limit_notional_mismatch", "M22 자동매매 지정가 주문 금액이 수량×가격과 일치하지 않습니다.", {
      requested_notional: requestedNotional.toString(),
      actual_limit_notional: actualLimitNotional.toString(),
    }));
  }

  if (actualLimitNotional.lt(upbitKrwMinimumOrderNotional)) {
    violations.push(blocked("order_notional_below_upbit_minimum", "M22 자동매매 주문 금액은 5000 KRW 이상이어야 합니다."));
  }

  if (actualLimitNotional.gt(effectiveMaxOrder)) {
    violations.push(blocked("max_order_budget_exceeded", "M22 자동매매 단일 주문 예산을 초과해 후보를 제출하지 않습니다."));
  }

  if (dailyUsed.plus(actualLimitNotional).gt(effectiveDailyLimit)) {
    violations.push(blocked("daily_budget_exceeded", "M22 자동매매 일일 예산을 초과해 후보를 제출하지 않습니다."));
  }

  if (currentOpenPosition.plus(actualLimitNotional).gt(effectiveMaxOpenPosition)) {
    violations.push(blocked("open_position_budget_exceeded", "M22 자동매매 open position 예산을 초과해 후보를 제출하지 않습니다."));
  }
}

/**
 * M22 entry 후보가 KRW 손실 한도를 초과했는지 검증한다.
 *
 * bps 기반 RiskGate가 아직 차단하지 않는 계정 상태라도, M22 소액 pilot의 절대 손실 한도를 넘으면 신규 entry를 열지 않는다.
 */
function appendLossLimitViolations(
  violations: RuntimeViolation[],
  request: LiveAutonomousEntryRuntimeRequest,
): void {
  const dailyLoss = parseNonNegativeDecimal(
    request.lossSnapshot.dailyRealizedLossKrw,
    "daily_realized_loss_krw",
    violations,
  );
  const weeklyLoss = parseNonNegativeDecimal(
    request.lossSnapshot.weeklyRealizedLossKrw,
    "weekly_realized_loss_krw",
    violations,
  );
  const maxDailyLoss = parsePositiveDecimal(request.config.max_daily_loss_krw, "max_daily_loss_krw", violations);
  const maxWeeklyLoss = parsePositiveDecimal(request.config.max_weekly_loss_krw, "max_weekly_loss_krw", violations);

  if (
    dailyLoss === undefined ||
    weeklyLoss === undefined ||
    maxDailyLoss === undefined ||
    maxWeeklyLoss === undefined
  ) {
    return;
  }

  if (dailyLoss.gt(maxDailyLoss)) {
    violations.push(blocked("daily_loss_limit_exceeded", "M22 자동매매 일일 손실 한도를 초과해 후보를 제출하지 않습니다.", {
      daily_realized_loss_krw: dailyLoss.toString(),
      max_daily_loss_krw: maxDailyLoss.toString(),
    }));
  }

  if (weeklyLoss.gt(maxWeeklyLoss)) {
    violations.push(blocked("weekly_loss_limit_exceeded", "M22 자동매매 주간 손실 한도를 초과해 후보를 제출하지 않습니다.", {
      weekly_realized_loss_krw: weeklyLoss.toString(),
      max_weekly_loss_krw: maxWeeklyLoss.toString(),
    }));
  }
}

/**
 * M22 entry 후보의 지정가가 기준 가격에서 허용 bps 이상 벗어났는지 검증한다.
 *
 * 가격 이탈이 큰 후보는 post-only라도 의도하지 않은 시장 상태를 반영할 수 있으므로 budget reservation 전에 차단한다.
 */
function appendPriceDeviationViolations(
  violations: RuntimeViolation[],
  request: LiveAutonomousEntryRuntimeRequest,
): void {
  const requestedPrice = parsePositiveDecimal(request.candidate.requestedPrice, "requested_price", violations);
  const referencePrice = parsePositiveDecimal(request.candidate.referencePrice, "reference_price", violations);
  const maxDeviationBps = parseNonNegativeDecimal(
    request.config.max_price_deviation_bps,
    "max_price_deviation_bps",
    violations,
  );

  if (requestedPrice === undefined || referencePrice === undefined || maxDeviationBps === undefined) {
    return;
  }

  if (!referencePrice.gt(0)) {
    violations.push(blocked("reference_price_invalid", "M22 자동매매 기준 가격은 0보다 커야 합니다."));
    return;
  }

  const deviationBps = requestedPrice.minus(referencePrice).abs().div(referencePrice).mul(10_000);
  if (deviationBps.gt(maxDeviationBps)) {
    violations.push(blocked("price_deviation_exceeded", "M22 자동매매 가격 이탈 한도를 초과해 후보를 제출하지 않습니다.", {
      deviation_bps: deviationBps.toString(),
      max_price_deviation_bps: request.config.max_price_deviation_bps,
    }));
  }
}

/**
 * M22 entry 후보를 ExecutionEngine이 검증할 BUY LIMIT POST_ONLY intent로 변환한다.
 *
 * idempotency key와 Upbit identifier는 같은 random identifier를 사용하며, 후보가 요청한 order type은 metadata에 남겨 차단/감사
 * 근거로 보존한다. 이 함수는 객체 변환만 수행하고 broker side effect를 만들지 않는다.
 */
function createEntryIntent(candidate: LiveAutonomousEntryCandidate, idempotencyKey: string): OrderIntent {
  return {
    exchangeId: candidate.exchangeId,
    market: candidate.market,
    strategyId: candidate.strategyId,
    side: "BUY",
    orderType: "LIMIT",
    requestedQuantity: candidate.requestedQuantity,
    requestedNotional: candidate.requestedNotional,
    requestedPrice: candidate.requestedPrice,
    idempotencyKey,
    reason: candidate.reason,
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      ...(candidate.metadata ?? {}),
      source: "live_autonomous_entry_runtime",
      reference_price: candidate.referencePrice,
      requested_order_type: candidate.orderType ?? "LIMIT",
    },
  };
}

/**
 * M22 entry attempt identifier를 결정한다.
 *
 * 기존 attempt retry는 같은 Upbit identifier를 재사용해야 중복 주문을 막을 수 있으므로 caller 제공값을 우선한다. 제공값이 없을
 * 때만 새 random identifier를 만들고, 제공값도 생성기와 같은 identifier 정책으로 검증한다.
 */
function resolveEntryIdempotencyKey(
  request: LiveAutonomousEntryRuntimeRequest,
  randomHex: LiveAutonomousEntryRuntimePorts["randomHex"],
): string {
  if (request.idempotencyKey === undefined) {
    return createLiveAutonomousIdentifier(request.config, randomHex);
  }

  const violations = validateLiveAutonomousIdentifier(request.config, request.idempotencyKey);
  if (violations.length > 0) {
    throw new UnsafeLiveAutonomousIdentifierError(violations);
  }

  return request.idempotencyKey;
}

/**
 * M22 entry 비용 입력을 CostModel 입력으로 승격한다.
 *
 * runtime이 생성한 identifier와 strategy scope를 metadata에 붙여 cost snapshot이 현재 주문 후보와 같은 fingerprint로 검증되게 한다.
 */
function createCostInput(
  candidate: LiveAutonomousEntryCandidate,
  intent: OrderIntent,
  observedAt: TimestampInput,
): CostModelInput {
  return {
    ...candidate.costInput,
    exchangeId: intent.exchangeId,
    market: intent.market,
    evaluatedAt: observedAt,
    metadata: {
      ...(candidate.costInput.metadata ?? {}),
      source: "live_autonomous_entry_runtime",
      idempotency_key: intent.idempotencyKey,
      strategy_id: intent.strategyId,
    },
  };
}

/**
 * M22 entry RiskGate context를 만든다.
 *
 * caller가 제공한 최신 risk snapshot에 runtime이 생성한 order intent와 expected loss를 결합한다. 이 context는 RiskGate 순수 평가
 * 입력이며 DB나 broker 조회를 수행하지 않는다.
 */
function createRiskContext(
  candidate: LiveAutonomousEntryCandidate,
  intent: OrderIntent,
  observedAt: TimestampInput,
): RiskGateContext {
  const context: RiskGateContext = {
    orderIntent: intent,
    account: candidate.risk.account,
    positions: candidate.risk.positions,
    strategy: candidate.risk.strategy,
    infrastructureSignals: candidate.risk.infrastructureSignals,
    thresholdSnapshot: candidate.risk.thresholdSnapshot,
    observedAt,
    expectedLossBpsOfEquity: candidate.expectedLossBpsOfEquity,
  };

  if (candidate.risk.metadata !== undefined) {
    context.metadata = {
      ...candidate.risk.metadata,
      source: "live_autonomous_entry_runtime",
      idempotency_key: intent.idempotencyKey,
    };
  }

  return context;
}

/**
 * M22 entry submission을 ExecutionEngine contract에 맞게 만든다.
 *
 * CostModel과 RiskGate 결과에 현재 intent fingerprint를 다시 붙여 stale evidence 재사용을 ExecutionEngine에서 차단할 수 있게 한다.
 */
function createSubmission(
  intent: OrderIntent,
  costDecision: CostDecision,
  riskContext: RiskGateContext,
  riskGateResult: RiskGateResult,
  observedAt: TimestampInput,
): OrderSubmission {
  const submission: OrderSubmission = {
    intent,
    costSnapshot: createExecutionCostSnapshotEvidence(
      costDecision.snapshot,
      intent,
      riskContext.expectedLossBpsOfEquity,
    ),
    riskApproval: createExecutionRiskApprovalEvidence(riskGateResult, riskContext),
    submittedAt: observedAt,
  };

  if (riskContext.expectedLossBpsOfEquity !== undefined) {
    submission.expectedLossBpsOfEquity = riskContext.expectedLossBpsOfEquity;
  }

  return submission;
}

/**
 * M22 entry runtime 반환 payload를 만든다.
 *
 * 사용자-facing message/action과 내부 trace를 분리하고, optional evidence는 값이 있을 때만 포함해 `exactOptionalPropertyTypes`
 * invariant를 유지한다.
 */
function createResult(input: {
  request: LiveAutonomousEntryRuntimeRequest;
  idempotencyKey: string;
  status: LiveAutonomousOrderAttemptStatus;
  message: string;
  action: string;
  violations: readonly string[];
  events: readonly LiveAutonomousOrderAttemptEvent[];
  trace: JsonRecord;
  intent?: OrderIntent;
  costDecision?: CostDecision;
  riskGateResult?: RiskGateResult;
  budgetReservation?: LiveAutonomousBudgetReservation;
  submission?: OrderSubmission;
  executionResult?: Awaited<ReturnType<LiveAutonomousEntryRuntimePorts["executionEngine"]["submitOrder"]>>;
}): LiveAutonomousEntryAttemptResult {
  const result: LiveAutonomousEntryAttemptResult = {
    attemptId: input.idempotencyKey,
    idempotencyKey: input.idempotencyKey,
    status: input.status,
    message: input.message,
    action: input.action,
    violations: input.violations,
    events: input.events,
    trace: {
      source: "live_autonomous_entry_runtime",
      market: input.request.candidate.market,
      strategy_id: input.request.candidate.strategyId,
      ...input.trace,
    },
  };

  assignIfDefined(result, "intent", input.intent);
  assignIfDefined(result, "costDecision", input.costDecision);
  assignIfDefined(result, "riskGateResult", input.riskGateResult);
  assignIfDefined(result, "budgetReservation", input.budgetReservation);
  assignIfDefined(result, "submission", input.submission);
  assignIfDefined(result, "executionResult", input.executionResult);

  return result;
}

/**
 * M22 entry preflight 차단 violation을 만든다.
 *
 * 기본 action은 운영자가 설정, 후보, 예산, readiness evidence를 다시 확인하도록 안내하며, 내부 metadata는 trace 영역으로만 전달한다.
 */
function blocked(reasonCode: string, message: string, metadata?: JsonRecord): RuntimeViolation {
  return {
    status: "BLOCKED",
    reasonCode,
    message,
    action: "설정, 후보, 예산, readiness evidence를 확인한 뒤 새 후보를 생성합니다.",
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * 0보다 커야 하는 M22 금융 문자열을 Decimal로 파싱한다.
 *
 * 주문 금액, 가격, 한도처럼 0이면 실행 의미가 없는 필드에 사용하며, 실패 시 broker 제출 전 violation을 누적한다.
 */
function parsePositiveDecimal(
  value: string,
  fieldName: string,
  violations: RuntimeViolation[],
): Decimal | undefined {
  try {
    const decimal = parseFinancialDecimal(value);
    if (!decimal.gt(0)) {
      violations.push(blocked("decimal_not_positive", "M22 자동매매 숫자 입력은 0보다 커야 합니다.", {
        field_name: fieldName,
      }));
      return undefined;
    }

    return decimal;
  } catch {
    violations.push(blocked("decimal_invalid", "M22 자동매매 숫자 입력을 해석할 수 없습니다.", {
      field_name: fieldName,
    }));
    return undefined;
  }
}

/**
 * 0 이상을 허용하는 M22 금융 문자열을 Decimal로 파싱한다.
 *
 * 일일 사용량과 open position notional처럼 첫 주문 전 0이 정상인 snapshot 필드에 사용한다.
 */
function parseNonNegativeDecimal(
  value: string,
  fieldName: string,
  violations: RuntimeViolation[],
): Decimal | undefined {
  try {
    const decimal = parseFinancialDecimal(value);
    if (decimal.isNegative()) {
      violations.push(blocked("decimal_negative", "M22 자동매매 숫자 입력은 음수일 수 없습니다.", {
        field_name: fieldName,
      }));
      return undefined;
    }

    return decimal;
  } catch {
    violations.push(blocked("decimal_invalid", "M22 자동매매 숫자 입력을 해석할 수 없습니다.", {
      field_name: fieldName,
    }));
    return undefined;
  }
}

/**
 * optional field를 값이 있을 때만 결과 객체에 붙인다.
 *
 * 런타임 결과의 선택 필드에 `undefined`를 명시적으로 넣지 않아 JSON-safe summary와 TypeScript exact optional invariant를 유지한다.
 */
function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
