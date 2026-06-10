import type {
  BrokerOrder,
  JsonRecord,
  OrderSubmission,
  TimestampInput,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type { ExitPaperRuntimeResult } from "../exit-engine/index.js";
import type {
  CreateLiveAutonomousExitStatusSummaryInput,
  LiveAutonomousExitReconcileSnapshot,
  LiveAutonomousExitStatusCode,
  LiveAutonomousExitStatusSummary,
} from "./types.js";

/**
 * M22 live autonomous exit 결과를 HTTP/Telegram/report safe summary로 변환한다.
 *
 * 기존 exit runtime 결과와 reconcile safe summary를 읽기 전용으로 해석한다. 부분 체결 잔량, cancel 실패, 재호가 intent,
 * reconcile mismatch를 신규 entry 차단 또는 수동 점검 문구로 낮추며, 이 함수 자체는 외부 side effect를 만들지 않는다.
 *
 * @param input startup guard, reconcile, 직전 exit runtime 결과
 * @returns 운영자 표면에 노출 가능한 M22 exit summary
 */
export function createLiveAutonomousExitStatusSummary(
  input: CreateLiveAutonomousExitStatusSummaryInput,
): LiveAutonomousExitStatusSummary {
  if (!input.enabled) {
    return createSummary({
      input,
      statusCode: "DISABLED",
      status: "ok",
      statusLabel: "M22 자동 청산 비활성",
      message: "M22 자동매매가 비활성이라 live autonomous exit 연결도 실행하지 않습니다.",
      impact: "실계좌 주문 side effect가 생성되지 않습니다.",
      action: "M22를 운영하려면 guard evidence와 readiness를 갖춘 뒤 별도 arm 절차를 진행하세요.",
      trace: { reason: "live_autonomous_exit_disabled" },
    });
  }

  if (!input.runtimeReady || !input.exitEngineReady) {
    return createSummary({
      input,
      statusCode: "BLOCKED",
      status: "warning",
      statusLabel: "M22 자동 청산 차단",
      message: "M22 guard 또는 exit engine readiness가 충족되지 않아 자동 청산 연결을 열지 않습니다.",
      impact: "자동 entry도 fail-closed 상태로 유지해야 합니다.",
      action: "M22 guard 위반, M19 exit engine readiness, 운영 evidence를 확인한 뒤 다시 평가하세요.",
      trace: {
        reason: "live_autonomous_exit_guard_blocked",
        runtimeReady: input.runtimeReady,
        exitEngineReady: input.exitEngineReady,
      },
    });
  }

  const reconcileBlock = evaluateReconcileBlock(input.reconcile);
  if (reconcileBlock !== null) {
    return createSummary({
      input,
      statusCode: "RECONCILE_REQUIRED",
      status: "warning",
      statusLabel: "reconcile 확인 필요",
      message: reconcileBlock.message,
      impact: "거래소-로컬 상태가 확정되기 전까지 신규 entry와 후속 청산 제출을 멈춥니다.",
      action: reconcileBlock.action,
      trace: {
        reason: reconcileBlock.reason,
        mismatchCount: input.reconcile.mismatchCount,
        openOrderCount: input.reconcile.openOrderCount,
        balanceStatus: input.reconcile.balanceStatus,
      },
    });
  }

  const lastExitResult = input.lastExitResult ?? null;
  if (lastExitResult === null) {
    return createSummary({
      input,
      statusCode: "READY",
      status: "ok",
      statusLabel: "자동 청산 대기",
      message: "M22 guard와 reconcile 상태가 충족됐고 최근 자동 청산 결과는 없습니다.",
      impact: "새 포지션이 열리면 exit engine 결과를 같은 summary 경계로 추적합니다.",
      action: "신규 entry 직전에도 kill switch, budget, PnL, reconcile freshness를 다시 확인하세요.",
      trace: { reason: "live_autonomous_exit_ready_no_recent_exit" },
    });
  }

  return summarizeExitRuntimeResult(input, lastExitResult);
}

/**
 * M22 live autonomous exit summary를 daily report 본문 section으로 변환한다.
 *
 * report는 내부 code를 첫 화면에 직접 노출하지 않고 한국어 상태/영향/필요 조치를 우선한다. 추적용 code는 별도 `추적 정보` 줄로
 * 낮춰 운영자가 원하면 audit/event와 연결할 수 있게 한다.
 *
 * @param summary safe summary 입력
 * @returns daily report에 붙일 한국어 section
 */
export function formatLiveAutonomousExitStatusReportSection(summary: LiveAutonomousExitStatusSummary): string {
  const lines = [
    "M22 자동매매/청산",
    `- 자동 청산 상태: ${summary.statusLabel}`,
    `- 설명: ${summary.message}`,
  ];

  if (summary.impact !== null) {
    lines.push(`- 영향: ${summary.impact}`);
  }
  if (summary.action !== null) {
    lines.push(`- 필요 조치: ${summary.action}`);
  }

  lines.push(
    `- reconcile: ${summary.reconcile.result}, 미체결 주문 ${formatNullableCount(summary.reconcile.openOrderCount)}건`,
    `- 추적 정보: ${summary.statusCode}`,
  );

  return lines.join("\n");
}

function summarizeExitRuntimeResult(
  input: CreateLiveAutonomousExitStatusSummaryInput,
  result: ExitPaperRuntimeResult,
): LiveAutonomousExitStatusSummary {
  const brokerOrder = readLatestBrokerOrder(result);
  const submission = result.submission;
  const filledQuantity = calculateFilledQuantity(result, submission, brokerOrder);
  const remainingQuantity = readRemainingQuantity(result, brokerOrder);
  const baseTrace = createExitTrace(result, brokerOrder);

  switch (result.status) {
    case "NO_EXIT_INTENT":
      return createSummary({
        input,
        result,
        statusCode: "NO_EXIT_INTENT",
        status: "ok",
        statusLabel: "청산 조건 없음",
        message: "exit engine이 최근 평가에서 청산 제출 후보를 만들지 않았습니다.",
        impact: "현재 포지션은 exit rule 기준에서 유지 상태입니다.",
        action: "다음 평가 frame과 PnL/reconcile 상태를 계속 관찰하세요.",
        filledQuantity,
        remainingQuantity,
        trace: { ...baseTrace, reason: "live_autonomous_exit_no_intent" },
      });
    case "EXECUTION_SUBMITTED":
      return createSummary({
        input,
        result,
        statusCode: "EXIT_SUBMITTED",
        status: "ok",
        statusLabel: "청산 제출 완료",
        message: "exit engine이 청산 주문을 제출했고 추가 cancel/requote가 필요한 미체결 잔량은 없습니다.",
        impact: "포지션 상태는 broker/reconcile snapshot으로 계속 검증해야 합니다.",
        action: "다음 reconcile에서 체결, 잔고, 포지션이 일치하는지 확인하세요.",
        filledQuantity,
        remainingQuantity,
        trace: { ...baseTrace, reason: "live_autonomous_exit_submitted" },
      });
    case "REMAINING_CANCEL_REQUOTE_CREATED":
      return createSummary({
        input,
        result,
        statusCode: "REQUOTE_INTENT_CREATED",
        status: "warning",
        statusLabel: "부분 체결 잔량 재호가 필요",
        message: "청산 주문이 부분 체결되어 미체결 잔량을 취소했고, 남은 수량의 재호가 intent가 생성됐습니다.",
        impact: "남은 포지션이 정리될 때까지 신규 entry를 열면 노출이 겹칠 수 있습니다.",
        action: "재호가 intent를 별도 exit 실행 경계에서 제출하고, 제출 전 최신 reconcile과 가격 조건을 다시 확인하세요.",
        filledQuantity,
        remainingQuantity,
        trace: {
          ...baseTrace,
          reason: "live_autonomous_exit_requote_required",
          requoteIntentIdempotencyKey: result.remainingIntent?.idempotencyKey ?? null,
        },
      });
    case "REMAINING_CANCEL_FAILED":
      return createSummary({
        input,
        result,
        statusCode: "MANUAL_REVIEW_REQUIRED",
        status: "unavailable",
        statusLabel: "잔량 취소 확인 필요",
        message: "청산 주문 잔량 취소가 실패했거나 취소 후에도 주문이 열린 상태로 남았습니다.",
        impact: "미체결 주문과 포지션 노출이 불확실하므로 자동 entry를 중단해야 합니다.",
        action: "거래소 open order와 로컬 주문 상태를 직접 대조한 뒤 수동으로 잔량을 취소하거나 정리하세요.",
        filledQuantity,
        remainingQuantity,
        trace: { ...baseTrace, reason: "live_autonomous_exit_remaining_cancel_failed" },
      });
    case "EXECUTION_REJECTED":
      return createSummary({
        input,
        result,
        statusCode: "MANUAL_REVIEW_REQUIRED",
        status: "warning",
        statusLabel: "청산 제출 차단",
        message: "exit engine이 청산 주문 제출을 거부했거나 broker 제출 후보를 만들지 못했습니다.",
        impact: "청산이 실행되지 않았으므로 포지션 위험이 남아 있을 수 있습니다.",
        action: "RiskGate, sizing, broker rejection evidence를 확인하고 필요하면 수동 청산을 진행하세요.",
        filledQuantity,
        remainingQuantity,
        trace: { ...baseTrace, reason: "live_autonomous_exit_execution_rejected" },
      });
  }
}

function createSummary(input: {
  input: CreateLiveAutonomousExitStatusSummaryInput;
  result?: ExitPaperRuntimeResult;
  statusCode: LiveAutonomousExitStatusCode;
  status: LiveAutonomousExitStatusSummary["status"];
  statusLabel: string;
  message: string;
  impact: string | null;
  action: string | null;
  filledQuantity?: string | null;
  remainingQuantity?: string | null;
  trace: JsonRecord;
}): LiveAutonomousExitStatusSummary {
  const latestBrokerOrder = input.result === undefined ? null : readLatestBrokerOrder(input.result);
  const submission = input.result?.submission;
  return {
    enabled: input.input.enabled,
    runtimeReady: input.input.runtimeReady,
    exitEngineReady: input.input.exitEngineReady,
    status: input.status,
    statusCode: input.statusCode,
    statusLabel: input.statusLabel,
    message: input.message,
    impact: input.impact,
    action: input.action,
    market: readMarket(submission, latestBrokerOrder),
    strategyId: readStrategyId(submission),
    latestBrokerOrderStatus: latestBrokerOrder?.status ?? null,
    filledQuantity: input.filledQuantity ?? null,
    remainingQuantity: input.remainingQuantity ?? latestBrokerOrder?.remainingQuantity ?? null,
    requoteIntentIdempotencyKey: input.result?.remainingIntent?.idempotencyKey ?? null,
    reconcile: input.input.reconcile,
    trace: {
      source: "live_autonomous_exit_status",
      observedAt: toIsoString(input.input.observedAt),
      statusCode: input.statusCode,
      ...input.trace,
    },
  };
}

function evaluateReconcileBlock(reconcile: LiveAutonomousExitReconcileSnapshot): {
  reason: string;
  message: string;
  action: string;
} | null {
  if (reconcile.result === "MISMATCH_DETECTED") {
    return {
      reason: "live_autonomous_exit_reconcile_mismatch",
      message: `reconcile에서 거래소-로컬 불일치 ${reconcile.mismatchCount ?? 0}건이 발견되어 자동 청산 연결을 멈춥니다.`,
      action: "불일치를 해소하고 reconcile을 다시 성공시킨 뒤 자동 entry/exit를 재개하세요.",
    };
  }

  if (reconcile.result === "FAILED" || reconcile.result === "UNAVAILABLE" || reconcile.balanceStatus === "UNAVAILABLE") {
    return {
      reason: "live_autonomous_exit_reconcile_unavailable",
      message: "reconcile 상태를 신뢰할 수 없어 자동 청산 연결을 멈춥니다.",
      action: "reconcile worker, DB, 잔고 snapshot 상태를 복구한 뒤 다시 확인하세요.",
    };
  }

  if (reconcile.balanceStatus === "STALE") {
    return {
      reason: "live_autonomous_exit_reconcile_balance_stale",
      message: "주문 상태는 확인됐지만 잠김 잔고가 stale 상태라 자동 청산 연결을 멈춥니다.",
      action: "거래소 잔고와 로컬 잔고를 직접 대조하고 reconcile을 재실행하세요.",
    };
  }

  if (reconcile.result === "SKIPPED") {
    return {
      reason: "live_autonomous_exit_reconcile_not_run",
      message: "reconcile이 아직 실행되지 않아 자동 청산 연결을 열지 않습니다.",
      action: "live reconcile을 한 번 이상 성공시킨 뒤 M22 guard를 다시 평가하세요.",
    };
  }

  return null;
}

function readLatestBrokerOrder(result: ExitPaperRuntimeResult): BrokerOrder | null {
  if (result.canceledOrder !== undefined) {
    return result.canceledOrder;
  }

  if (result.executionResult !== undefined && result.executionResult.status !== "REJECTED") {
    return result.executionResult.brokerOrder;
  }

  return null;
}

function readMarket(submission: OrderSubmission | undefined, brokerOrder: BrokerOrder | null) {
  return submission?.intent.market ?? brokerOrder?.market ?? null;
}

function readStrategyId(submission: OrderSubmission | undefined): string | null {
  return submission?.intent.strategyId ?? null;
}

function readRemainingQuantity(result: ExitPaperRuntimeResult, brokerOrder: BrokerOrder | null): string | null {
  if (result.remainingIntent !== undefined) {
    return result.remainingIntent.requestedQuantity;
  }

  return brokerOrder?.remainingQuantity ?? null;
}

function calculateFilledQuantity(
  result: ExitPaperRuntimeResult,
  submission: OrderSubmission | undefined,
  brokerOrder: BrokerOrder | null,
): string | null {
  if (submission === undefined || brokerOrder === null) {
    return null;
  }

  try {
    const requested = parseFinancialDecimal(submission.intent.requestedQuantity);
    const remainingQuantity = result.remainingIntent?.requestedQuantity ?? brokerOrder.remainingQuantity;
    const remaining = parseFinancialDecimal(remainingQuantity);
    return requested.minus(remaining).toFixed();
  } catch {
    return null;
  }
}

function createExitTrace(result: ExitPaperRuntimeResult, brokerOrder: BrokerOrder | null): JsonRecord {
  return {
    exitRuntimeStatus: result.status,
    brokerOrderId: brokerOrder?.brokerOrderId ?? null,
    brokerOrderStatus: brokerOrder?.status ?? null,
    executionPersistenceStatus: result.executionPersistenceStatus,
    evidenceWriteStatus: result.evidenceWriteStatus,
    evidenceCount: result.evidenceItems.length,
  };
}

function formatNullableCount(value: number | null): string {
  return value === null ? "확인 불가" : `${value}`;
}

function toIsoString(value: TimestampInput): string {
  return value instanceof Date ? value.toISOString() : value;
}
