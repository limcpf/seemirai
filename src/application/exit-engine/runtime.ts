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
    return {
      status: "NO_EXIT_INTENT",
      evidenceItems,
      executionPersistenceStatus: "NOT_APPLICABLE",
      evidenceWriteStatus: await appendExitEvidenceSafely(input.ports.evidenceWriter, evidenceItems),
    };
  }

  const executionResult = await input.ports.executionEngine.submitOrder(submissionResult.submission);
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

  const remaining = evaluatePartialFillRemaining(brokerOrder, submissionResult.exitOrderIntent);
  try {
    // 미체결 또는 부분 체결 open 잔량은 그대로 두면 포지션/PnL evidence와 주문 상태가 갈라지므로 먼저 취소로 닫는다.
    const canceledOrder = await input.ports.broker.cancelOrder(brokerOrder.brokerOrderId);
    if (canceledOrder.status !== "CANCELED" || canceledOrder.remainingQuantity !== "0") {
      appendManualReviewEvidence(
        evidenceItems,
        "청산 주문 잔량 취소 후에도 주문이 열려 있습니다.",
        "exit_remaining_cancel_open",
        input.positionScope,
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
    const remainingIntent = remaining.requiresNewIntent
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
  evidenceItems.push(
    createExitExecutionEvidence({
      decision: input.decision,
      sizing: input.sizing,
      correlationId: brokerOrder.brokerOrderId,
      executionStatus,
      filledQuantity,
      remainingQuantity: brokerOrder.remainingQuantity,
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

function appendManualReviewEvidence(
  evidenceItems: DecisionEvidenceItem[],
  reason: string,
  reasonCode: string,
  scope: ExitPositionScope,
): void {
  evidenceItems.push(
    createExitFailureManualReviewEvidence(
      reason,
      reasonCode,
      scope.market,
      scope.strategyId,
      toDate(scope.observedAt),
      `exit-failure-${reasonCode}-${scope.market}-${scope.strategyId}`,
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
  try {
    return parseFinancialDecimal(intent.requestedQuantity)
      .minus(parseFinancialDecimal(brokerOrder.remainingQuantity))
      .toFixed();
  } catch {
    return "0";
  }
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

function toDate(value: TimestampInput): Date {
  return value instanceof Date ? value : new Date(value);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "알 수 없는 오류";
}
