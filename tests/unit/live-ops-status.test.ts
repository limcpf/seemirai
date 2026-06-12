import { describe, expect, it } from "vitest";
import {
  createLiveOpsStatusSummary,
  formatLiveOpsStatusReportSection,
} from "../../src/application/index.js";
import type { CreateLiveOpsStatusSummaryInput } from "../../src/application/index.js";

const observedAt = "2026-06-12T00:00:00.000Z";

describe("live ops status summary", () => {
  it("marks M23 as live order capable only when runtime, key, reconcile, and risk gates pass", () => {
    const summary = createLiveOpsStatusSummary(liveOpsInput());

    expect(summary).toMatchObject({
      status: "ok",
      statusLabel: "실매매 가능",
      mode: "live_order_capable",
      liveEnabled: true,
      liveOrderCapable: true,
      paperNoKey: false,
      readiness: {
        keyScopeSafe: true,
        telegramInboundReady: true,
        reconcileFresh: true,
        pnlStatusReady: true,
        decisionLedgerReady: true,
        exitEngineReady: true,
      },
      budget: {
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        maxOpenPositionNotionalKrw: "30000",
        dailyNotionalUsedKrw: "5000",
        openExposureKrw: "12000",
        realizedPnlKrw: "1200",
        unrealizedPnlKrw: "-300",
      },
      trace: {
        source: "live_ops_status_summary",
        reason: "live_order_capable",
      },
    });
    expect(summary.message).toContain("주문 가능 상태");
  });

  it("does not report live order capable when the process is still paper/no-key", () => {
    const summary = createLiveOpsStatusSummary(liveOpsInput({
      paperNoKey: true,
    }));

    expect(summary).toMatchObject({
      status: "warning",
      statusLabel: "상태 관측 전용",
      mode: "heartbeat_only",
      liveOrderCapable: false,
      paperNoKey: true,
      trace: {
        reason: "paper_no_key",
      },
    });
    expect(summary.message).toContain("실거래 키가 없는 모의 운영 상태");
    expect(summary.message).not.toContain("heartbeat_only");
  });

  it("requires a connected and fresh heartbeat before reporting live order capable", () => {
    const summary = createLiveOpsStatusSummary(liveOpsInput({
      marketData: {
        connectionStatus: "unknown",
        lagMs: null,
        updatedAt: null,
      },
      latestHeartbeat: null,
    }));

    expect(summary).toMatchObject({
      status: "unavailable",
      statusLabel: "실매매 상태 확인 불가",
      mode: "live_armed",
      liveOrderCapable: false,
      latestHeartbeat: {
        statusLabel: "heartbeat 미연결",
      },
      trace: {
        reason: "heartbeat_unavailable",
      },
    });
    expect(summary.message).toContain("최신 market data heartbeat");
    expect(summary.action).toContain("market data heartbeat");
  });

  it("keeps risk blocks and missing event evidence visible for closeout", () => {
    const summary = createLiveOpsStatusSummary(liveOpsInput({
      latestDecision: null,
      latestOrderAttempt: null,
      tradingState: {
        killSwitchState: "NEW_ORDERS_BLOCKED",
        newOrdersBlocked: true,
        requiresManualReview: false,
        blockedReason: "operator_pause",
      },
    }));

    expect(summary).toMatchObject({
      status: "warning",
      liveOrderCapable: false,
      latestDecision: {
        statusLabel: "판단 기록 없음",
        action: "M23 status provider에 해당 evidence source를 연결하세요.",
      },
      latestOrderAttempt: {
        statusLabel: "주문 시도 없음",
      },
      riskBlock: {
        killSwitchState: "NEW_ORDERS_BLOCKED",
        newOrdersBlocked: true,
        blockedReason: "operator_pause",
      },
      trace: {
        reason: "new_orders_blocked",
      },
    });
    expect(summary.action).toContain("kill switch reason");
  });

  it("formats a Korean-first daily report section without raw provider payloads", () => {
    const summary = createLiveOpsStatusSummary(liveOpsInput());
    const section = formatLiveOpsStatusReportSection(summary);

    expect(section).toContain("M23 live 운영 상태");
    expect(section).toContain("상태: 실매매 가능");
    expect(section).toContain("매매 가능: 예");
    expect(section).toContain("최신 주문/체결: 주문 제출 / 전체 체결");
    expect(section).toContain("필요 조치: 후보 처리 전에도 budget");
    expect(section).not.toContain("secret-provider-detail");
  });
});

function liveOpsInput(overrides: Partial<CreateLiveOpsStatusSummaryInput> = {}): CreateLiveOpsStatusSummaryInput {
  const base: CreateLiveOpsStatusSummaryInput = {
    observedAt,
    runtimeMode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
    paperNoKey: false,
    liveTradingEnabled: true,
    liveAutonomous: {
      enabled: true,
      ready: true,
      allowedMarkets: ["KRW-BTC"],
      maxOrderKrw: "10000",
      dailyAutonomousNotionalLimitKrw: "30000",
      maxOpenPositionNotionalKrw: "30000",
      keyScopeEvidenceConfigured: true,
      telegramInboundReady: true,
      reconcileFresh: true,
      pnlStatusReady: true,
      decisionLedgerReady: true,
      exitEngineReady: true,
      statusLabel: "M23 guard 통과",
      message: "M23 guard evidence가 모두 준비됐습니다.",
      action: null,
      trace: {
        source: "live_autonomous_runtime_guard",
        reason: "live_autonomous_guard_ready",
      },
    },
    marketData: {
      connectionStatus: "CONNECTED",
      lagMs: 50,
      updatedAt: observedAt,
    },
    reconcile: {
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: 1,
      lastReconcileAt: observedAt,
      actionRequired: "정상",
    },
    pnl: {
      statusLabel: "조회 가능",
      latestCapturedAt: observedAt,
      latestEquityKrw: "1000000",
      latestRealizedPnlKrw: "1200",
      latestUnrealizedPnlKrw: "-300",
    },
    tradingState: {
      killSwitchState: "NORMAL",
      newOrdersBlocked: false,
      requiresManualReview: false,
      blockedReason: null,
    },
    alerts: {
      statusLabel: "조회 가능",
      lastSentAt: observedAt,
      lastSkippedAt: null,
      action: null,
    },
    latestHeartbeat: {
      statusLabel: "수신 확인",
      message: "market data heartbeat를 확인했습니다.",
      observedAt,
      action: null,
      trace: {
        source: "market_data_status",
      },
    },
    latestCandidate: {
      statusLabel: "후보 확인",
      message: "최근 주문 후보가 예산 한도 안에서 생성됐습니다.",
      observedAt,
      action: null,
      trace: {
        source: "order_candidate",
      },
    },
    latestDecision: {
      statusLabel: "매수 판단",
      message: "최근 frame은 매수 후보를 승인했습니다.",
      observedAt,
      action: null,
      trace: {
        source: "decision_ledger",
      },
    },
    latestOrderAttempt: {
      statusLabel: "주문 제출",
      message: "최근 live order attempt가 한도 안에서 제출됐습니다.",
      observedAt,
      action: null,
      trace: {
        source: "live_order_attempt",
      },
    },
    latestFillOrCancel: {
      statusLabel: "전체 체결",
      message: "최근 주문이 전체 체결됐습니다.",
      observedAt,
      action: null,
      trace: {
        source: "broker_order_status",
      },
    },
    dailyNotionalUsedKrw: "5000",
    openExposureKrw: "12000",
  };

  return {
    ...base,
    ...overrides,
  };
}
