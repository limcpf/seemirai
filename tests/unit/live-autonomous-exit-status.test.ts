import { describe, expect, it, vi } from "vitest";
import {
  LiveAutonomousExitRuntime,
  createLiveAutonomousExitStatusSummary,
  formatLiveAutonomousExitStatusReportSection,
} from "../../src/application/index.js";
import type {
  BrokerOrder,
  OrderSubmission,
} from "../../src/domain/index.js";
import type { ExitPaperRuntimeResult } from "../../src/application/index.js";
import type { LiveAutonomousExitRunnerInput } from "../../src/application/index.js";

const observedAt = "2026-06-10T12:30:00.000Z";

describe("M22 live autonomous exit status summary", () => {
  it("비활성 M22에서는 live exit 연결도 안전하게 닫힌 상태로 표시한다", () => {
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: false,
      runtimeReady: false,
      exitEngineReady: false,
      observedAt,
      reconcile: cleanReconcile(),
    });

    expect(summary).toMatchObject({
      status: "ok",
      statusCode: "DISABLED",
      statusLabel: "M22 자동 청산 비활성",
      market: null,
      latestBrokerOrderStatus: null,
    });
    expect(summary.message).toContain("실행하지 않습니다");
    expect(summary.trace).toMatchObject({
      source: "live_autonomous_exit_status",
      reason: "live_autonomous_exit_disabled",
    });
  });

  it("reconcile mismatch가 있으면 최근 exit 결과보다 먼저 fail-closed 조치를 표시한다", () => {
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: {
        ...cleanReconcile(),
        result: "MISMATCH_DETECTED",
        mismatchCount: 2,
        openOrderCount: 1,
      },
      lastExitResult: exitSubmittedResult(),
    });

    expect(summary).toMatchObject({
      status: "warning",
      statusCode: "RECONCILE_REQUIRED",
      statusLabel: "reconcile 확인 필요",
    });
    expect(summary.message).toContain("불일치 2건");
    expect(summary.action).toContain("reconcile을 다시 성공");
    expect(summary.trace).toMatchObject({
      reason: "live_autonomous_exit_reconcile_mismatch",
      mismatchCount: 2,
      openOrderCount: 1,
    });
  });

  it("orchestration runtime skips M19 exit runner when reconcile is not clean", async () => {
    const runExit = vi.fn(async () => exitSubmittedResult());
    const runtime = new LiveAutonomousExitRuntime({ runExit });

    const result = await runtime.runExitIfSafe({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: {
        ...cleanReconcile(),
        result: "MISMATCH_DETECTED",
        mismatchCount: 1,
      },
      exitInput: emptyExitRunnerInput(),
    });

    expect(result.status).toBe("SKIPPED");
    expect(result.summary.statusCode).toBe("RECONCILE_REQUIRED");
    expect(runExit).not.toHaveBeenCalled();
  });

  it("orchestration runtime calls M19 exit runner after clean guard and summarizes the result", async () => {
    const runExit = vi.fn(async () => exitRequoteResult());
    const runtime = new LiveAutonomousExitRuntime({ runExit });

    const result = await runtime.runExitIfSafe({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      exitInput: emptyExitRunnerInput(),
    });

    expect(result.status).toBe("EXECUTED");
    expect(result.summary.statusCode).toBe("REQUOTE_INTENT_CREATED");
    expect(runExit).toHaveBeenCalledTimes(1);
  });

  it("부분 체결 후 cancel/requote 결과를 사용자 문구와 trace로 분리한다", () => {
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      lastExitResult: exitRequoteResult(),
    });

    expect(summary).toMatchObject({
      status: "warning",
      statusCode: "REQUOTE_INTENT_CREATED",
      statusLabel: "부분 체결 잔량 재호가 필요",
      market: "KRW-BTC",
      strategyId: "trend_following",
      latestBrokerOrderStatus: "CANCELED",
      filledQuantity: "0.0046",
      remainingQuantity: "0.0004",
    });
    expect(summary.message).toContain("부분 체결");
    expect(summary.message).not.toContain("exit-original-001-requote");
    expect(summary.trace).toMatchObject({
      reason: "live_autonomous_exit_requote_required",
      exitRuntimeStatus: "REMAINING_CANCEL_REQUOTE_CREATED",
      brokerOrderId: "upbit-exit-1",
      requoteIntentIdempotencyKey: "exit-original-001-requote-upbit-exit-1-1",
    });
  });

  it("잔량 취소 실패는 manual review required 상태로 보고한다", () => {
    const result = exitRequoteResult();
    const { remainingIntent: _remainingIntent, ...failedResult } = result;
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      lastExitResult: {
        ...failedResult,
        status: "REMAINING_CANCEL_FAILED",
        canceledOrder: {
          ...result.canceledOrder!,
          status: "PARTIALLY_FILLED",
          remainingQuantity: "0.0004",
        },
      },
    });

    expect(summary).toMatchObject({
      status: "unavailable",
      statusCode: "MANUAL_REVIEW_REQUIRED",
      statusLabel: "잔량 취소 확인 필요",
      remainingQuantity: "0.0004",
    });
    expect(summary.action).toContain("수동으로 잔량을 취소");
  });

  it("잔량 취소 실패에서는 취소 시도 후 최신 broker 잔량을 사용한다", () => {
    const result = exitRequoteResult();
    const { remainingIntent: _remainingIntent, ...failedResult } = result;
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      lastExitResult: {
        ...failedResult,
        status: "REMAINING_CANCEL_FAILED",
        canceledOrder: {
          ...result.canceledOrder!,
          status: "PARTIALLY_FILLED",
          remainingQuantity: "0.0002",
        },
      },
    });

    expect(summary).toMatchObject({
      statusCode: "MANUAL_REVIEW_REQUIRED",
      filledQuantity: "0.0048",
      remainingQuantity: "0.0002",
    });
  });

  it("broker submit 이후 persistence 기록 실패를 정상 청산으로 표시하지 않는다", () => {
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      lastExitResult: {
        ...exitSubmittedResult(),
        executionPersistenceStatus: "UNAVAILABLE",
      },
    });

    expect(summary).toMatchObject({
      status: "unavailable",
      statusCode: "MANUAL_REVIEW_REQUIRED",
      statusLabel: "청산 기록 확인 필요",
    });
    expect(summary.action).toContain("로컬 주문/체결/포지션 저장 상태");
    expect(summary.trace).toMatchObject({
      reason: "live_autonomous_exit_recording_failed",
      executionPersistenceStatus: "UNAVAILABLE",
    });
  });

  it("cancel snapshot remaining=0 때문에 부분 체결 수량을 전체 체결로 부풀리지 않는다", () => {
    const { remainingIntent: _remainingIntent, ...dustRemainingResult } = exitRequoteResult();
    const summary = createLiveAutonomousExitStatusSummary({
      enabled: true,
      runtimeReady: true,
      exitEngineReady: true,
      observedAt,
      reconcile: cleanReconcile(),
      lastExitResult: {
        ...dustRemainingResult,
        status: "EXECUTION_SUBMITTED",
      },
    });

    expect(summary).toMatchObject({
      statusCode: "EXIT_SUBMITTED",
      latestBrokerOrderStatus: "CANCELED",
      filledQuantity: "0.0046",
      remainingQuantity: "0.0004",
    });
  });

  it("daily report section은 내부 code를 추적 정보 줄로 낮춘다", () => {
    const section = formatLiveAutonomousExitStatusReportSection(
      createLiveAutonomousExitStatusSummary({
        enabled: true,
        runtimeReady: true,
        exitEngineReady: true,
        observedAt,
        reconcile: cleanReconcile(),
        lastExitResult: exitRequoteResult(),
      }),
    );

    expect(section).toContain("M22 자동매매/청산");
    expect(section).toContain("자동 청산 상태: 부분 체결 잔량 재호가 필요");
    expect(section).toContain("추적 정보: REQUOTE_INTENT_CREATED");
    expect(section).not.toContain("upbit-exit-1");
  });
});

function cleanReconcile() {
  return {
    result: "SUCCESS" as const,
    mismatchCount: 0,
    openOrderCount: 0,
    balanceStatus: "OK" as const,
    websocketStatus: "CONNECTED" as const,
    lastReconcileAt: observedAt,
  };
}

function exitSubmittedResult(): ExitPaperRuntimeResult {
  return {
    status: "EXECUTION_SUBMITTED",
    submission: exitSubmission(),
    executionResult: {
      status: "SUBMITTED",
      submission: exitSubmission(),
      brokerOrder: brokerOrder({ status: "FILLED", remainingQuantity: "0" }),
    },
    evidenceItems: [],
    executionPersistenceStatus: "RECORDED",
    evidenceWriteStatus: "RECORDED",
  };
}

function exitRequoteResult(): ExitPaperRuntimeResult {
  return {
    status: "REMAINING_CANCEL_REQUOTE_CREATED",
    submission: exitSubmission(),
    executionResult: {
      status: "SUBMITTED",
      submission: exitSubmission(),
      brokerOrder: brokerOrder({ status: "PARTIALLY_FILLED", remainingQuantity: "0.0004" }),
    },
    canceledOrder: brokerOrder({ status: "CANCELED", remainingQuantity: "0" }),
    remainingIntent: {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "SELL",
      orderType: "LIMIT",
      requestedQuantity: "0.0004",
      requestedNotional: "51200",
      idempotencyKey: "exit-original-001-requote-upbit-exit-1-1",
      reason: "잔량 청산 재시도",
      requestedPrice: "128000000",
      timeInForce: "GTC",
      metadata: {
        position_effect: "REDUCE",
        exit_reason_code: "risk_reduction_requote",
        exit_rule_id: "risk_reduction_exit",
        position_scope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
      },
    },
    evidenceItems: [],
    executionPersistenceStatus: "RECORDED",
    evidenceWriteStatus: "RECORDED",
  };
}

function exitSubmission(): OrderSubmission {
  return {
    intent: {
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      strategyId: "trend_following",
      side: "SELL",
      orderType: "LIMIT",
      requestedQuantity: "0.005",
      requestedNotional: "640000",
      idempotencyKey: "exit-original-001",
      reason: "리스크 축소",
      requestedPrice: "128000000",
      timeInForce: "GTC",
      metadata: {
        position_effect: "REDUCE",
        exit_reason_code: "risk_reduction",
        exit_rule_id: "risk_reduction_exit",
        position_scope: {
          market: "KRW-BTC",
          strategyId: "trend_following",
          totalQuantity: "0.005",
          observedAt,
        },
      },
    },
    costSnapshot: { source: "exit_cost_model", exit_cost_allowed: true },
    riskApproval: { source: "risk_gate", approved: true },
    submittedAt: observedAt,
  };
}

function brokerOrder(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    brokerOrderId: "upbit-exit-1",
    idempotencyKey: "exit-original-001",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "SELL",
    orderType: "LIMIT",
    status: "PARTIALLY_FILLED",
    requestedQuantity: "0.005",
    remainingQuantity: "0.0004",
    requestedPrice: "128000000",
    acceptedAt: observedAt,
    updatedAt: observedAt,
    ...overrides,
  };
}

function emptyExitRunnerInput(): LiveAutonomousExitRunnerInput {
  return {} as LiveAutonomousExitRunnerInput;
}
