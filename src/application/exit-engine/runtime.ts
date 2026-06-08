import type {
  BrokerOrder,
  ExitDecision,
  ExitOrderIntent,
  ExitPolicySnapshot,
  ExitPositionScope,
  ExitSizing,
  JsonRecord,
  OrderSubmission,
  TimestampInput,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { BrokerPort } from "../ports/index.js";
import type { ExecutionEngine, ExecutionSubmitOrderResult } from "../execution/index.js";
import type { DecisionEvidenceItem } from "../decision-ledger/types.js";
import { createExitSubmission } from "./submission.js";
import type { ExitSubmissionResult } from "./submission.js";
import {
  createExitExecutionEvidence,
  createExitFailureManualReviewEvidence,
  createExitRemainingBelowMinNotionalEvidence,
  createExitRemainingDustEvidence,
  createExitPnLStatusEvidence,
  createExitStrategyEvidence,
} from "./runtime-evidence.js";
import {
  createRemainingExitIntent,
  evaluatePartialFillRemaining,
} from "./remaining-intent.js";

export type ExitRuntimeEvidenceWriteStatus = "NOT_CONFIGURED" | "RECORDED" | "UNAVAILABLE";
export type ExitRuntimeExecutionPersistenceStatus = "NOT_APPLICABLE" | "NOT_CONFIGURED" | "RECORDED" | "UNAVAILABLE";

/**
 * exit paper execution 결과를 durable 주문/체결/포지션 저장소와 연결하는 최소 port다.
 *
 * application layer는 DB repository 구현을 모르고, broker side effect 이후 최종 broker order snapshot을 한 번만 넘긴다.
 * persistence 실패는 broker 재시도로 복구하지 않고 manual review evidence와 `UNAVAILABLE` 상태로 노출한다.
 */
export interface ExitRuntimeExecutionPersistencePort {
  persistPaperExecution(input: {
    submission: OrderSubmission;
    brokerOrder: BrokerOrder;
    correlationId?: string;
  }): Promise<unknown>;
}

/**
 * exit runtime이 decision ledger 또는 audit 저장소와 만나는 최소 port다.
 *
 * 이 port는 application layer가 concrete DB repository를 import하지 않게 하면서도, exit 판단/실행/실패 evidence가
 * runtime 흐름 끝에서 append-only writer로 전달됐는지 테스트할 수 있게 한다. writer 실패는 이미 발생한 broker side effect를
 * 재시도하지 않고 `UNAVAILABLE` 상태로만 보고한다.
 */
export interface ExitRuntimeEvidenceWriterPort {
  appendExitEvidence(evidenceItems: readonly DecisionEvidenceItem[]): Promise<void>;
}

/**
 * exit paper runtime 실행에 필요한 side-effect port 묶음이다.
 *
 * `executionEngine`은 RiskGate/cost evidence 검증 이후 broker submit을 담당하고, `broker`는 미체결/open 잔량 취소만 담당한다.
 * persistence/evidence writer는 선택적이며, 미주입 시 runtime은 결과와 evidence item을 반환만 한다.
 */
export interface ExitPaperRuntimePorts {
  executionEngine: Pick<ExecutionEngine, "submitOrder">;
  broker: Pick<BrokerPort, "cancelOrder">;
  executionPersistence?: ExitRuntimeExecutionPersistencePort;
  evidenceWriter?: ExitRuntimeEvidenceWriterPort;
}

/**
 * exit paper runtime 실행 입력이다.
 *
 * 호출자는 이미 Sub PR 01 rule/sizing과 RiskGate 평가를 끝낸 뒤 이 입력을 만든다. 이 함수는 scope나 idempotency key를
 * 추정하지 않으며, 결측 값이 있으면 broker side effect 후보를 만들지 않는다.
 */
export interface ExitPaperRuntimeInput {
  decision: ExitDecision;
  sizing: ExitSizing;
  positionScope: ExitPositionScope;
  policySnapshot: ExitPolicySnapshot;
  currentPrice: string;
  riskApproval: JsonRecord;
  idempotencyKey: string;
  submittedAt: TimestampInput;
  expectedLossBpsOfEquity?: string;
  ports: ExitPaperRuntimePorts;
}

/**
 * exit paper runtime 실행 결과다.
 *
 * 반환값은 broker submit 결과, open 잔량 cancel/requote 결과, append-only evidence writer 상태를 함께 담아 Sub PR 03 closeout과
 * `/status.why` 연결부가 같은 사건을 추적할 수 있게 한다.
 */
export interface ExitPaperRuntimeResult {
  status:
    | "NO_EXIT_INTENT"
    | "EXECUTION_REJECTED"
    | "EXECUTION_SUBMITTED"
    | "REMAINING_CANCEL_REQUOTE_CREATED"
    | "REMAINING_CANCEL_FAILED";
  submission?: OrderSubmission;
  executionResult?: ExecutionSubmitOrderResult;
  canceledOrder?: BrokerOrder;
  remainingIntent?: ExitOrderIntent;
  evidenceItems: readonly DecisionEvidenceItem[];
  executionPersistenceStatus: ExitRuntimeExecutionPersistenceStatus;
  evidenceWriteStatus: ExitRuntimeEvidenceWriteStatus;
}

/**
 * exit 판단을 paper execution runtime에 연결한다.
 *
 * 이 함수는 `ExitDecision -> OrderSubmission -> ExecutionEngine -> PaperBroker cancel/requote -> evidence writer` 순서를
 * 하나로 묶는다. live broker나 DB 구현체를 직접 알지 않고, open 잔량 취소 실패는 신규 진입 중지/manual review evidence로
 * 수렴시킨다.
 */
export async function runExitPaperRuntime(input: ExitPaperRuntimeInput): Promise<ExitPaperRuntimeResult> {
  const evidenceItems: DecisionEvidenceItem[] = [
    createExitStrategyEvidence(input.decision, input.positionScope.market, input.positionScope.strategyId),
  ];

  if (shouldSurfaceSizingFailure(input.decision, input.sizing)) {
    // exit rule이 이미 발화한 뒤 sizing이 실패하면 무동작이 아니라 신규 진입 차단/manual review 사건으로 남긴다.
    appendManualReviewEvidence(
      evidenceItems,
      "청산 주문 수량 산정이 유효하지 않아 broker 제출을 차단했습니다.",
      input.sizing.rejectionReason ?? "exit_sizing_invalid",
      input.positionScope,
      createInputEventScope(input),
    );
    return {
      status: "EXECUTION_REJECTED",
      evidenceItems,
      executionPersistenceStatus: "NOT_APPLICABLE",
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  const submissionResult = createExitSubmission({
    decision: input.decision,
    sizing: input.sizing,
    positionScope: input.positionScope,
    policySnapshot: input.policySnapshot,
    currentPrice: input.currentPrice,
    riskApproval: input.riskApproval,
    idempotencyKey: input.idempotencyKey,
    submittedAt: input.submittedAt,
    ...(input.expectedLossBpsOfEquity === undefined ? {} : { expectedLossBpsOfEquity: input.expectedLossBpsOfEquity }),
  });

  if (submissionResult === null) {
    if (isTriggeredExitDecision(input.decision)) {
      appendManualReviewEvidence(
        evidenceItems,
        "청산 주문 제출 후보를 만들 수 없어 broker 제출을 차단했습니다.",
        "exit_submission_construction_failed",
        input.positionScope,
        createInputEventScope(input),
      );
      return {
        status: "EXECUTION_REJECTED",
        evidenceItems,
        executionPersistenceStatus: "NOT_APPLICABLE",
        evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
      };
    }

    return {
      status: "NO_EXIT_INTENT",
      evidenceItems,
      executionPersistenceStatus: "NOT_APPLICABLE",
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  let executionResult: ExecutionSubmitOrderResult;
  try {
    executionResult = await input.ports.executionEngine.submitOrder(submissionResult.submission);
  } catch (error) {
    // broker 제출 경계에서 예외가 발생해도 caller crash로 끝내지 않고 exit 실패 evidence를 append-only로 남긴다.
    appendManualReviewEvidence(
      evidenceItems,
      `청산 주문 broker 제출에 실패했습니다: ${readErrorMessage(error)}`,
      "exit_broker_submit_failed",
      input.positionScope,
      createInputEventScope(input),
    );
    return {
      status: "EXECUTION_REJECTED",
      submission: submissionResult.submission,
      evidenceItems,
      executionPersistenceStatus: "NOT_APPLICABLE",
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }
  if (executionResult.status === "REJECTED") {
    appendRejectedExecutionEvidence(evidenceItems, input, submissionResult, executionResult.rejection.message);
    return {
      status: "EXECUTION_REJECTED",
      submission: submissionResult.submission,
      executionResult,
      evidenceItems,
      executionPersistenceStatus: "NOT_APPLICABLE",
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  const brokerOrder = executionResult.brokerOrder;
  appendSubmittedExecutionEvidence(evidenceItems, input, submissionResult, brokerOrder);
  if (isBrokerTerminalFailure(brokerOrder.status)) {
    // broker가 거부/실패 snapshot을 돌려준 경우 remainingQuantity를 체결 근거로 추론하지 않고 즉시 review로 수렴한다.
    appendManualReviewEvidence(
      evidenceItems,
      `청산 주문이 broker에서 거부되거나 실패했습니다. 상태: ${brokerOrder.status}`,
      "exit_broker_order_terminal_failure",
      input.positionScope,
      brokerOrder.brokerOrderId,
    );
    const executionPersistenceStatus = await persistExitExecutionSafely(
      input,
      submissionResult.submission,
      brokerOrder,
      evidenceItems,
    );
    return {
      status: "EXECUTION_REJECTED",
      submission: submissionResult.submission,
      executionResult,
      evidenceItems,
      executionPersistenceStatus,
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  if (!hasOpenRemainingQuantity(brokerOrder)) {
    const executionPersistenceStatus = await persistExitExecutionSafely(
      input,
      submissionResult.submission,
      brokerOrder,
      evidenceItems,
    );
    return {
      status: "EXECUTION_SUBMITTED",
      submission: submissionResult.submission,
      executionResult,
      evidenceItems,
      executionPersistenceStatus,
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  const remaining = evaluatePartialFillRemaining(
    brokerOrder,
    submissionResult.exitOrderIntent,
    { dustThreshold: input.policySnapshot.dustThreshold },
  );
  try {
    // 미체결 또는 부분 체결 open 잔량은 그대로 두면 포지션/PnL evidence와 주문 상태가 갈라지므로 먼저 취소로 닫는다.
    const canceledOrder = await input.ports.broker.cancelOrder(brokerOrder.brokerOrderId);
    if (canceledOrder.status !== "CANCELED" || !isZeroQuantity(canceledOrder.remainingQuantity)) {
      appendManualReviewEvidence(
        evidenceItems,
        "청산 주문 잔량 취소 후에도 주문이 열려 있습니다.",
        "exit_remaining_cancel_open",
        input.positionScope,
        canceledOrder.brokerOrderId,
      );
      const executionPersistenceStatus = await persistExitExecutionSafely(
        input,
        submissionResult.submission,
        canceledOrder,
        evidenceItems,
      );
      return {
        status: "REMAINING_CANCEL_FAILED",
        submission: submissionResult.submission,
        executionResult,
        canceledOrder,
        evidenceItems,
        executionPersistenceStatus,
        evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
      };
    }

    appendCanceledExecutionEvidence(evidenceItems, input, submissionResult, canceledOrder, remaining.filledQuantity);
    if (remaining.isDust) {
      appendDustRemainingEvidence(evidenceItems, input, submissionResult, canceledOrder, remaining);
    }
    const remainingBelowMinOrderNotional = remaining.requiresNewIntent
      ? evaluateRemainingBelowMinOrderNotional(
        submissionResult.exitOrderIntent,
        remaining.remainingQuantity,
        input.policySnapshot,
      )
      : undefined;
    if (remainingBelowMinOrderNotional?.belowMinOrderNotional === true) {
      // dust보다 큰 잔량도 최소 주문금액 미만이면 broker 거부가 예상되므로 재호가 intent를 만들지 않는다.
      appendRemainingBelowMinOrderNotionalEvidence(
        evidenceItems,
        input,
        submissionResult,
        canceledOrder,
        remaining,
        remainingBelowMinOrderNotional.remainingNotional,
      );
    }
    const remainingIntent = remaining.requiresNewIntent && remainingBelowMinOrderNotional?.belowMinOrderNotional !== true
      ? createRemainingExitIntent(
        submissionResult.exitOrderIntent,
        remaining.remainingQuantity,
        {
          lineageId: brokerOrder.brokerOrderId,
          requoteSequence: 1,
        },
      ) ?? undefined
      : undefined;

    const executionPersistenceStatus = await persistExitExecutionSafely(
      input,
      submissionResult.submission,
      canceledOrder,
      evidenceItems,
    );

    return {
      status: remainingIntent === undefined ? "EXECUTION_SUBMITTED" : "REMAINING_CANCEL_REQUOTE_CREATED",
      submission: submissionResult.submission,
      executionResult,
      canceledOrder,
      ...(remainingIntent === undefined ? {} : { remainingIntent }),
      evidenceItems,
      executionPersistenceStatus,
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  } catch (error) {
    appendManualReviewEvidence(
      evidenceItems,
      `청산 주문 잔량 취소에 실패했습니다: ${readErrorMessage(error)}`,
      "exit_remaining_cancel_failed",
      input.positionScope,
      brokerOrder.brokerOrderId,
    );
    const executionPersistenceStatus = await persistExitExecutionSafely(
      input,
      submissionResult.submission,
      brokerOrder,
      evidenceItems,
    );
    return {
      status: "REMAINING_CANCEL_FAILED",
      submission: submissionResult.submission,
      executionResult,
      evidenceItems,
      executionPersistenceStatus,
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }
}

/**
 * exit/REDUCE 결정에서 sizing이 실패한 경우 broker 제출 없이 실패 evidence를 노출해야 하는지 판단한다.
 *
 * HOLD/BLOCK의 null submission은 정상 무동작이지만, 발화된 청산 결정의 invalid sizing은 청산 실패로 다뤄야 한다.
 */
function shouldSurfaceSizingFailure(decision: ExitDecision, sizing: ExitSizing): boolean {
  return !sizing.valid && isTriggeredExitDecision(decision);
}

/**
 * 실제 청산 side effect가 필요한 decision인지 판단한다.
 *
 * 이 predicate는 HOLD/BLOCK의 정상 무동작과 REDUCE/EXIT 실패를 런타임 evidence에서 분리하는 기준이다.
 */
function isTriggeredExitDecision(decision: ExitDecision): boolean {
  return decision.kind === "REDUCE" || decision.kind === "EXIT";
}

function appendRejectedExecutionEvidence(
  evidenceItems: DecisionEvidenceItem[],
  input: ExitPaperRuntimeInput,
  submissionResult: ExitSubmissionResult,
  rejectionMessage: string,
): void {
  evidenceItems.push(
    createExitExecutionEvidence({
      decision: input.decision,
      sizing: input.sizing,
      correlationId: submissionResult.exitOrderIntent.idempotencyKey,
      executionStatus: "REJECTED",
      filledQuantity: "0",
      remainingQuantity: input.sizing.executableQuantity,
      exitIntention: submissionResult.exitOrderIntent.metadata.position_effect,
      market: input.positionScope.market,
      strategyId: input.positionScope.strategyId,
      evidenceKey: `exit-execution-rejected-${submissionResult.exitOrderIntent.idempotencyKey}`,
    }, toDate(input.submittedAt)),
    createExitFailureManualReviewEvidence(
      rejectionMessage,
      "exit_execution_rejected",
      input.positionScope.market,
      input.positionScope.strategyId,
      toDate(input.submittedAt),
      `exit-failure-${submissionResult.exitOrderIntent.idempotencyKey}`,
    ),
  );
}

function appendSubmittedExecutionEvidence(
  evidenceItems: DecisionEvidenceItem[],
  input: ExitPaperRuntimeInput,
  submissionResult: ExitSubmissionResult,
  brokerOrder: BrokerOrder,
): void {
  const executionStatus = mapBrokerOrderStatusToExitExecutionStatus(brokerOrder.status);
  const filledQuantity = calculateFilledQuantity(submissionResult.exitOrderIntent, brokerOrder);
  const remainingPositionQuantity = calculateRemainingPositionQuantity(input.positionScope, filledQuantity);
  const remainingQuantity = readBrokerRemainingQuantityForExecutionEvidence(
    submissionResult.exitOrderIntent,
    brokerOrder,
  );
  evidenceItems.push(
    createExitExecutionEvidence({
      decision: input.decision,
      sizing: input.sizing,
      correlationId: brokerOrder.brokerOrderId,
      executionStatus,
      filledQuantity,
      remainingQuantity,
      exitIntention: submissionResult.exitOrderIntent.metadata.position_effect,
      market: input.positionScope.market,
      strategyId: input.positionScope.strategyId,
      evidenceKey: `exit-execution-${brokerOrder.brokerOrderId}-${executionStatus}`,
    }, toDate(brokerOrder.updatedAt)),
    createExitPnLStatusEvidence(
      input.positionScope.market,
      input.positionScope.strategyId,
      remainingPositionQuantity,
      brokerOrder.requestedPrice ?? null,
      toDate(brokerOrder.updatedAt),
      `exit-pnl-${brokerOrder.brokerOrderId}`,
    ),
  );
}

function appendCanceledExecutionEvidence(
  evidenceItems: DecisionEvidenceItem[],
  input: ExitPaperRuntimeInput,
  submissionResult: ExitSubmissionResult,
  canceledOrder: BrokerOrder,
  filledQuantity: string,
): void {
  evidenceItems.push(
    createExitExecutionEvidence({
      decision: input.decision,
      sizing: input.sizing,
      correlationId: canceledOrder.brokerOrderId,
      executionStatus: "CANCELED",
      filledQuantity,
      remainingQuantity: canceledOrder.remainingQuantity,
      exitIntention: submissionResult.exitOrderIntent.metadata.position_effect,
      market: input.positionScope.market,
      strategyId: input.positionScope.strategyId,
      evidenceKey: `exit-execution-${canceledOrder.brokerOrderId}-CANCELED`,
    }, toDate(canceledOrder.updatedAt)),
  );
}

function appendDustRemainingEvidence(
  evidenceItems: DecisionEvidenceItem[],
  input: ExitPaperRuntimeInput,
  submissionResult: ExitSubmissionResult,
  canceledOrder: BrokerOrder,
  remaining: ReturnType<typeof evaluatePartialFillRemaining>,
): void {
  evidenceItems.push(
    createExitRemainingDustEvidence({
      correlationId: canceledOrder.brokerOrderId,
      filledQuantity: remaining.filledQuantity,
      remainingQuantity: remaining.remainingQuantity,
      canceledQuantity: remaining.remainingQuantity,
      brokerRemainingQuantityAfterCancel: canceledOrder.remainingQuantity,
      dustThreshold: input.policySnapshot.dustThreshold,
      exitIntention: submissionResult.exitOrderIntent.metadata.position_effect,
      market: input.positionScope.market,
      strategyId: input.positionScope.strategyId,
      evidenceKey: `exit-dust-${canceledOrder.brokerOrderId}`,
    }, toDate(canceledOrder.updatedAt)),
  );
}

function appendRemainingBelowMinOrderNotionalEvidence(
  evidenceItems: DecisionEvidenceItem[],
  input: ExitPaperRuntimeInput,
  submissionResult: ExitSubmissionResult,
  canceledOrder: BrokerOrder,
  remaining: ReturnType<typeof evaluatePartialFillRemaining>,
  remainingNotional: string,
): void {
  evidenceItems.push(
    createExitRemainingBelowMinNotionalEvidence({
      correlationId: canceledOrder.brokerOrderId,
      filledQuantity: remaining.filledQuantity,
      remainingQuantity: remaining.remainingQuantity,
      brokerRemainingQuantityAfterCancel: canceledOrder.remainingQuantity,
      remainingNotional,
      minOrderNotional: input.policySnapshot.minOrderNotional,
      exitIntention: submissionResult.exitOrderIntent.metadata.position_effect,
      market: input.positionScope.market,
      strategyId: input.positionScope.strategyId,
      evidenceKey: `exit-min-notional-${canceledOrder.brokerOrderId}`,
    }, toDate(canceledOrder.updatedAt)),
  );
}

function appendManualReviewEvidence(
  evidenceItems: DecisionEvidenceItem[],
  reason: string,
  reasonCode: string,
  scope: ExitPositionScope,
  eventScopeId: string,
): void {
  evidenceItems.push(
    createExitFailureManualReviewEvidence(
      reason,
      reasonCode,
      scope.market,
      scope.strategyId,
      toDate(scope.observedAt),
      `exit-failure-${reasonCode}-${scope.market}-${scope.strategyId}-${eventScopeId}`,
    ),
  );
}

async function appendExitEvidenceSafely(
  writer: ExitRuntimeEvidenceWriterPort | undefined,
  evidenceItems: readonly DecisionEvidenceItem[],
): Promise<ExitRuntimeEvidenceWriteStatus> {
  if (writer === undefined) {
    return "NOT_CONFIGURED";
  }

  try {
    // ledger 저장 실패는 이미 발생한 broker submit/cancel side effect를 재시도하지 않고 상태로만 보고한다.
    await writer.appendExitEvidence(evidenceItems);
    return "RECORDED";
  } catch {
    return "UNAVAILABLE";
  }
}

async function persistExitExecutionSafely(
  input: ExitPaperRuntimeInput,
  submission: OrderSubmission,
  brokerOrder: BrokerOrder,
  evidenceItems: DecisionEvidenceItem[],
): Promise<ExitRuntimeExecutionPersistenceStatus> {
  const persistence = input.ports.executionPersistence;
  if (persistence === undefined) {
    return "NOT_CONFIGURED";
  }

  try {
    // broker side effect 이후에는 같은 주문을 재제출하지 않고 최종 broker snapshot만 durable 저장소에 한 번 기록한다.
    await persistence.persistPaperExecution({
      submission,
      brokerOrder,
      correlationId: brokerOrder.brokerOrderId,
    });
    return "RECORDED";
  } catch (error) {
    appendManualReviewEvidence(
      evidenceItems,
      `청산 실행 결과 저장에 실패했습니다: ${readErrorMessage(error)}`,
      "exit_execution_persistence_unavailable",
      input.positionScope,
      brokerOrder.brokerOrderId,
    );
    return "UNAVAILABLE";
  }
}

function mapBrokerOrderStatusToExitExecutionStatus(
  status: BrokerOrder["status"],
): "FILLED" | "PARTIALLY_FILLED" | "OPEN" | "REJECTED" | "FAILED" | "CANCELED" {
  switch (status) {
    case "FILLED":
      return "FILLED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "SUBMITTED":
    case "ACCEPTED":
      return "OPEN";
    case "CANCELED":
      return "CANCELED";
    case "REJECTED":
      return "REJECTED";
    case "FAILED":
      return "FAILED";
    default:
      return "FAILED";
  }
}

function calculateFilledQuantity(intent: ExitOrderIntent, brokerOrder: BrokerOrder): string {
  if (isBrokerTerminalFailure(brokerOrder.status)) {
    return "0";
  }

  try {
    return parseFinancialDecimal(intent.requestedQuantity)
      .minus(parseFinancialDecimal(brokerOrder.remainingQuantity))
      .toFixed();
  } catch {
    return "0";
  }
}

/**
 * 실패 terminal broker snapshot의 잔량 표현은 거래소마다 다를 수 있어 evidence에는 요청 잔량을 보수적으로 남긴다.
 *
 * 이 함수는 `remainingQuantity: "0"`을 "전량 체결"로 오해하지 않도록 EXECUTION_RESULT payload를 보정한다.
 */
function readBrokerRemainingQuantityForExecutionEvidence(intent: ExitOrderIntent, brokerOrder: BrokerOrder): string {
  return isBrokerTerminalFailure(brokerOrder.status) ? intent.requestedQuantity : brokerOrder.remainingQuantity;
}

function calculateRemainingPositionQuantity(scope: ExitPositionScope, filledQuantity: string): string {
  try {
    const remaining = parseFinancialDecimal(scope.totalQuantity).minus(parseFinancialDecimal(filledQuantity));
    if (remaining.lte(0)) {
      return "0";
    }
    return remaining.toFixed();
  } catch {
    return scope.totalQuantity;
  }
}

/**
 * cancel 결과 잔량이 숫자상 0인지 확인한다.
 *
 * broker adapter가 `"0.00000000"`처럼 scale을 유지해 반환해도 open 주문으로 오판하지 않게 한다.
 */
function isZeroQuantity(value: string): boolean {
  try {
    return parseFinancialDecimal(value).isZero();
  } catch {
    return value === "0";
  }
}

/**
 * 부분 체결 후 남은 잔량이 최소 주문금액 이상인지 평가한다.
 *
 * parse 실패 시 여기서 임의로 통과/차단하지 않고 기존 재호가 생성 경로가 null로 수렴하게 둔다.
 */
function evaluateRemainingBelowMinOrderNotional(
  intent: ExitOrderIntent,
  remainingQuantity: string,
  policySnapshot: ExitPolicySnapshot,
): { belowMinOrderNotional: boolean; remainingNotional: string } | undefined {
  try {
    const remainingNotional = parseFinancialDecimal(intent.requestedPrice)
      .mul(parseFinancialDecimal(remainingQuantity));
    return {
      belowMinOrderNotional: remainingNotional.lessThan(parseFinancialDecimal(policySnapshot.minOrderNotional)),
      remainingNotional: remainingNotional.toFixed(),
    };
  } catch {
    return undefined;
  }
}

function hasOpenRemainingQuantity(brokerOrder: BrokerOrder): boolean {
  if (brokerOrder.status !== "SUBMITTED" && brokerOrder.status !== "ACCEPTED" && brokerOrder.status !== "PARTIALLY_FILLED") {
    return false;
  }

  try {
    return parseFinancialDecimal(brokerOrder.remainingQuantity).gt(0);
  } catch {
    return brokerOrder.remainingQuantity !== "0";
  }
}

/**
 * broker가 주문을 받아 실행 중으로 둔 것이 아니라 최종 실패로 닫았는지 판단한다.
 *
 * terminal failure에서는 remainingQuantity 값을 체결 추론에 사용하지 않고 실패 evidence로만 처리한다.
 */
function isBrokerTerminalFailure(status: BrokerOrder["status"]): boolean {
  return status === "REJECTED" || status === "FAILED";
}

function toDate(value: TimestampInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}

/**
 * broker order id가 아직 없는 사전 실패 구간에서 사용할 사건 scope를 만든다.
 *
 * idempotency key가 비어 있는 construction 실패도 제출 시각을 함께 포함해 반복 실패 evidence가 같은 fingerprint로 합쳐지지 않게 한다.
 */
function createInputEventScope(input: ExitPaperRuntimeInput): string {
  const idempotencyKey = input.idempotencyKey.trim();
  const stableKey = idempotencyKey.length > 0 ? idempotencyKey : "missing-idempotency-key";
  return `${stableKey}-${toDate(input.submittedAt).toISOString()}`;
}
