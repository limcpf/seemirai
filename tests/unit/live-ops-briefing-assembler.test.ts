import { describe, expect, it } from "vitest";
import {
  createLiveOpsBriefingSnapshot,
  createLiveOpsStatusSummary,
  formatLiveOpsBriefing,
} from "../../src/application/index.js";
import type {
  CreateLiveOpsStatusSummaryInput,
  WhySummary,
} from "../../src/application/index.js";

const observedAt = "2026-06-25T03:00:00.000Z";

describe("live ops briefing assembler", () => {
  it("connects live ops status, why summary, market freshness, and portfolio projections", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture(),
      market: {
        freshnessLabel: "정상",
        summary: "KRW-BTC ticker와 orderbook이 5초 이내에 갱신됐습니다.",
        observedAt,
      },
      portfolio: {
        cash: {
          statusLabel: "조회 완료",
          availableKrw: "120000",
          totalKrw: "125000",
          observedAt,
        },
        balances: [
          {
            market: "KRW-BTC",
            currency: "BTC",
            total: "0.002",
            available: "0.001",
            statusLabel: "일부 잠김",
          },
        ],
        positions: [
          {
            market: "KRW-BTC",
            quantity: "0.002",
            averageEntryPriceKrw: "60000000",
            statusLabel: "전략 보유",
          },
        ],
        pnl: {
          statusLabel: "조회 완료",
          realizedKrw: "1200",
          unrealizedKrw: "-300",
          equityKrw: "1000000",
          observedAt,
        },
        openExposureKrw: "12000",
        budgetUsedKrw: "5000",
      },
      trace: {
        evidenceIds: ["m23-status-001"],
        reasonCodes: ["operator_brief_requested"],
        sourceIds: ["telegram-brief-command"],
      },
    });

    expect(snapshot).toMatchObject({
      observedAt,
      headline: {
        statusLabel: "실매매 가능",
        cause: "M23 live small-budget runtime이 guard, reconcile, kill switch 조건을 통과해 주문 가능 상태입니다.",
        impact: "소액 한도 안에서 live order API 호출 경계로 전진할 수 있습니다.",
        action: "후보 처리 전에도 budget, price deviation, reconcile freshness를 다시 확인하세요.",
      },
      runtime: {
        daemonAlive: true,
        runModeLabel: "실매매 가능",
        liveEnabled: true,
        liveArmed: true,
        liveOrderCapable: true,
      },
      market: {
        freshnessLabel: "정상",
        summary: "KRW-BTC ticker와 orderbook이 5초 이내에 갱신됐습니다.",
        observedAt,
      },
      portfolio: {
        cash: {
          availableKrw: "120000",
          totalKrw: "125000",
        },
        balances: [
          {
            market: "KRW-BTC",
            total: "0.002",
            available: "0.001",
          },
        ],
        positions: [
          {
            market: "KRW-BTC",
            quantity: "0.002",
          },
        ],
        pnl: {
          equityKrw: "1000000",
        },
        openExposureKrw: "12000",
        budgetUsedKrw: "5000",
      },
    });
    expect(snapshot.decisions.latestCandidate).toContain("최근 주문 후보가 예산 한도 안에서 생성됐습니다.");
    expect(snapshot.decisions.latestEntryDecision).toContain("KRW-BTC: 진입 보류");
    expect(snapshot.decisions.latestExitDecision).toContain("exit-small-budget: 청산 대기");
    expect(snapshot.decisions.buyConditions).toEqual(["KRW-BTC: 진입 보류"]);
    expect(snapshot.decisions.sellConditions).toEqual(["exit-small-budget: 청산 대기"]);
    expect(snapshot.decisions.holdReason).toContain("비용 차감 후 기대값 부족 2건");
    expect(snapshot.decisions.blockReason).toBeNull();
    expect(snapshot.operations.openOrders).toBe("미체결 주문 1건");
    expect(snapshot.operations.reconcile).toContain("SUCCESS");
    expect(snapshot.trace.evidenceIds).toContain("m23-status-001");
    expect(snapshot.trace.reasonCodes).toEqual(expect.arrayContaining([
      "operator_brief_requested",
      "live_order_capable",
      "entry_hold_cost_margin",
    ]));
    expect(snapshot.trace.sourceIds).toEqual(expect.arrayContaining([
      "telegram-brief-command",
      "live_ops_status_summary",
      "decision_ledger_why_summary",
    ]));

    const briefing = formatLiveOpsBriefing(snapshot);
    expect(briefing).toContain("상태: 실매매 가능");
    expect(briefing).toContain("시장 상태");
    expect(briefing).toContain("coin/position: KRW-BTC total 0.002 BTC, available 0.001 BTC 일부 잠김");
    expect(briefing).toContain("HOLD 이유: 비용 차감 후 기대값 부족 2건");
  });

  it("represents missing provider sources as unavailable observations without zero coercion", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: null,
      why: null,
      market: null,
      portfolio: null,
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.headline.statusLabel).toBe("관측 없음");
    expect(snapshot.runtime).toMatchObject({
      daemonAlive: false,
      runModeLabel: "관측 없음",
      liveEnabled: false,
      liveArmed: false,
      liveOrderCapable: false,
      readinessGuard: "Live Ops status source가 아직 briefing assembler에 연결되지 않았습니다.",
    });
    expect(snapshot.market).toEqual({
      freshnessLabel: "관측 없음",
      summary: "시장 데이터 freshness source가 아직 briefing assembler에 연결되지 않았습니다.",
      observedAt: null,
    });
    expect(snapshot.decisions).toMatchObject({
      latestCandidate: "관측 없음",
      latestEntryDecision: "관측 없음",
      latestExitDecision: "관측 없음",
      buyConditions: [],
      sellConditions: [],
      holdReason: null,
      blockReason: "decision ledger why summary source가 아직 briefing assembler에 연결되지 않았습니다.",
    });
    expect(snapshot.portfolio).toMatchObject({
      cash: {
        statusLabel: "관측 없음",
        availableKrw: null,
        totalKrw: null,
        observedAt: null,
      },
      balances: [],
      positions: [],
      pnl: {
        statusLabel: "관측 없음",
        realizedKrw: null,
        unrealizedKrw: null,
        equityKrw: null,
        observedAt: null,
      },
      openExposureKrw: null,
      budgetUsedKrw: null,
    });
    expect(snapshot.trace.reasonCodes).toEqual(expect.arrayContaining([
      "live_ops_status_unavailable",
      "decision_ledger_why_unavailable",
      "market_data_source_unavailable",
      "portfolio_source_unavailable",
    ]));
    expect(briefing).toContain("현금: 관측 없음");
    expect(briefing).toContain("coin/position: 관측 없음");
    expect(briefing).toContain("PnL: 관측 없음");
    expect(briefing).not.toContain("0 KRW");
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

function whySummaryFixture(): WhySummary {
  return {
    markets: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "시장별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [
        {
          market: "KRW-BTC",
          statusLabel: "진입 보류",
          message: "비용 차감 후 기대값이 안전 버퍼를 넘지 못했습니다.",
          impact: "신규 매수 후보는 HOLD 상태입니다.",
          action: "스프레드와 호가 깊이를 다시 확인하세요.",
          latestDecisionAt: observedAt,
          trace: {
            category: "HOLD",
            reasonCode: "entry_hold_cost_margin",
          },
        },
      ],
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    strategies: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "전략별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [
        {
          strategyId: "exit-small-budget",
          statusLabel: "청산 대기",
          message: "익절과 손절 조건이 모두 충족되지 않았습니다.",
          impact: "기존 포지션은 관측만 계속합니다.",
          action: "exit guard를 유지하세요.",
          latestDecisionAt: observedAt,
          trace: {
            category: "HOLD",
            reasonCode: "exit_hold_no_signal",
          },
        },
      ],
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    cash: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "현금 보유 이유를 조회했습니다.",
      impact: null,
      action: null,
      item: {
        statusLabel: "현금 보유",
        message: "주문 후보 0건 frame에서 현금 보유로 판단했습니다.",
        impact: "신규 진입은 보류됩니다.",
        action: "조건 충족 전까지 신규 진입을 열지 마세요.",
        latestDecisionAt: observedAt,
        holdReasons: [
          {
            label: "비용 차감 후 기대값 부족",
            count: 2,
            trace: {
              reasonCode: "entry_hold_cost_margin",
            },
          },
        ],
        trace: {
          category: "CASH_HOLD",
          reasonCode: "entry_hold_cost_margin",
        },
      },
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    generatedAt: observedAt,
    readStatus: "OK",
    trace: {
      querySource: "decision_ledger_frames",
    },
  };
}
