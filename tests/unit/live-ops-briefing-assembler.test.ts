import { describe, expect, it } from "vitest";
import {
  createLiveOpsBriefingSnapshot,
  createLiveOpsStatusSummary,
  formatLiveOpsBriefing,
} from "../../src/application/index.js";
import type {
  CreateLiveOpsStatusSummaryInput,
  DecisionCategory,
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
    expect(snapshot.operations.openOrders).toContain("주문 시도: 주문 제출");
    expect(snapshot.operations.openOrders).toContain("체결/취소: 전체 체결");
    expect(snapshot.operations.openOrders).toContain("미체결 주문 1건");
    expect(snapshot.operations.reconcile).toContain("reconcile 정상");
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

  it("keeps explicit portfolio PnL null unavailable instead of falling back to status PnL", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture(),
      portfolio: {
        pnl: null,
      },
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.portfolio.pnl).toEqual({
      statusLabel: "관측 없음",
      realizedKrw: null,
      unrealizedKrw: null,
      equityKrw: null,
      observedAt: null,
    });
    expect(briefing).toContain("PnL: 관측 없음");
    expect(briefing).not.toContain("실현 1200 KRW");
    expect(snapshot.portfolio.openExposureKrw).toBe("12000");
    expect(snapshot.portfolio.budgetUsedKrw).toBe("5000");
  });

  it("keeps explicit exposure and budget null unavailable instead of falling back to status budget", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture(),
      portfolio: {
        openExposureKrw: null,
        budgetUsedKrw: null,
      },
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.portfolio.openExposureKrw).toBeNull();
    expect(snapshot.portfolio.budgetUsedKrw).toBeNull();
    expect(briefing).toContain("예산/노출: 관측 없음");
    expect(briefing).not.toContain("open exposure 12000 KRW");
  });

  it("keeps explicit portfolio null unavailable instead of falling back to status PnL", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture(),
      portfolio: null,
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.portfolio.pnl).toEqual({
      statusLabel: "관측 없음",
      realizedKrw: null,
      unrealizedKrw: null,
      equityKrw: null,
      observedAt: null,
    });
    expect(snapshot.portfolio.openExposureKrw).toBeNull();
    expect(snapshot.portfolio.budgetUsedKrw).toBeNull();
    expect(snapshot.trace.reasonCodes).toContain("portfolio_source_unavailable");
    expect(briefing).toContain("PnL: 관측 없음");
    expect(briefing).not.toContain("실현 1200 KRW");
  });

  it("surfaces unavailable why summaries in the decision area", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: unavailableWhySummaryFixture(),
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.decisions.latestEntryDecision).toContain("시장별 판단 이유 조회 불가");
    expect(snapshot.decisions.latestExitDecision).toContain("전략별 판단 이유 조회 불가");
    expect(snapshot.decisions.blockReason).toContain("decision ledger why summary 조회 불가");
    expect(snapshot.trace.reasonCodes).toContain("decision_ledger_why_unavailable");
    expect(briefing).toContain("BLOCK 이유: decision ledger why summary 조회 불가");
  });

  it("keeps why NOT_FOUND as no-record observations instead of failure block reasons", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: notFoundWhySummaryFixture(),
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.decisions.latestEntryDecision).toContain("시장별 판단 이유 기록 없음");
    expect(snapshot.decisions.latestExitDecision).toContain("전략별 판단 이유 기록 없음");
    expect(snapshot.decisions.blockReason).toBeNull();
    expect(briefing).toContain("BLOCK 이유: 관측 없음");
    expect(briefing).not.toContain("decision ledger why summary 조회 불가");
  });

  it("uses latest decision timestamps and does not treat generic strategy BUY as sell conditions", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture({
        markets: [
          {
            market: "KRW-BTC",
            statusLabel: "오래된 보류",
            message: "오래된 시장 판단입니다.",
            latestDecisionAt: "2026-06-25T02:00:00.000Z",
            category: "HOLD",
            reasonCode: "old_hold",
          },
          {
            market: "KRW-ETH",
            statusLabel: "최신 진입 대기",
            message: "가장 최신 시장 판단입니다.",
            latestDecisionAt: "2026-06-25T03:10:00.000Z",
            category: "BUY",
            reasonCode: "latest_buy_candidate",
          },
        ],
        strategies: [
          {
            strategyId: "trend-following",
            statusLabel: "매수 후보",
            message: "전략은 매수 후보를 유지합니다.",
            latestDecisionAt: "2026-06-25T03:20:00.000Z",
            category: "BUY",
            reasonCode: "strategy_buy_candidate",
          },
        ],
      }),
    });

    expect(snapshot.decisions.latestEntryDecision).toContain("KRW-ETH: 최신 진입 대기");
    expect(snapshot.decisions.latestExitDecision).toBe("관측 없음");
    expect(snapshot.decisions.buyConditions).toEqual([
      "KRW-BTC: 오래된 보류",
      "KRW-ETH: 최신 진입 대기",
    ]);
    expect(snapshot.decisions.sellConditions).toEqual([]);
    expect(snapshot.trace.reasonCodes).toEqual(expect.arrayContaining([
      "latest_buy_candidate",
      "strategy_buy_candidate",
    ]));
  });

  it("classifies production exit HOLD reasons as sell conditions without relying on strategy id", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: whySummaryFixture({
        strategies: [
          {
            strategyId: "live_ops_autonomous_24x7_core",
            statusLabel: "포지션 보유",
            message: "보유 포지션은 손절과 익절 조건을 아직 충족하지 않았습니다.",
            latestDecisionAt: observedAt,
            category: "HOLD",
            reasonCode: "autonomous_24x7_position_hold",
          },
          {
            strategyId: "trend-following",
            statusLabel: "매수 후보",
            message: "전략은 매수 후보를 유지합니다.",
            latestDecisionAt: "2026-06-25T03:20:00.000Z",
            category: "BUY",
            reasonCode: "strategy_buy_candidate",
          },
        ],
      }),
    });

    expect(snapshot.decisions.latestExitDecision).toContain("live_ops_autonomous_24x7_core: 포지션 보유");
    expect(snapshot.decisions.sellConditions).toEqual([
      "live_ops_autonomous_24x7_core: 포지션 보유",
    ]);
    expect(snapshot.decisions.sellConditions).not.toContain("trend-following: 매수 후보");
  });

  it("classifies executed SELL market decisions as sell conditions instead of entry conditions", () => {
    const summary = whySummaryFixture({
      markets: [
        {
          market: "KRW-BTC",
          statusLabel: "실행 완료",
          message: "보유 포지션 청산 주문이 체결됐습니다.",
          latestDecisionAt: observedAt,
          category: "EXECUTED",
          reasonCode: "exit_sell_executed",
          trace: {
            orderSide: "SELL",
          },
        },
      ],
      strategies: [],
    });

    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput()),
      why: summary,
    });

    expect(snapshot.decisions.latestEntryDecision).toContain("최근 frame은 매수 후보를 승인했습니다.");
    expect(snapshot.decisions.latestExitDecision).toContain("KRW-BTC: 실행 완료");
    expect(snapshot.decisions.buyConditions).toEqual([]);
    expect(snapshot.decisions.sellConditions).toEqual(["KRW-BTC: 실행 완료"]);
  });

  it("does not mark the daemon stopped when only market heartbeat is missing", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput({
        marketData: {
          connectionStatus: "unknown",
          lagMs: null,
          updatedAt: null,
        },
        latestHeartbeat: null,
      })),
      why: whySummaryFixture(),
    });
    const briefing = formatLiveOpsBriefing(snapshot);

    expect(snapshot.runtime.daemonAlive).toBe(true);
    expect(snapshot.runtime.readinessGuard).toContain("market data heartbeat");
    expect(snapshot.market.freshnessLabel).toBe("관측 없음");
    expect(briefing).toContain("daemon: 작동 중");
    expect(briefing).not.toContain("daemon: 중지됨");
  });

  it("keeps internal risk reason codes in trace instead of user-facing briefing text", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput({
        tradingState: {
          killSwitchState: "NEW_ORDERS_BLOCKED",
          newOrdersBlocked: true,
          requiresManualReview: false,
          blockedReason: "operator_pause",
        },
      })),
      why: whySummaryFixture(),
    });
    const briefing = formatLiveOpsBriefing(snapshot);
    const visibleBriefing = briefing.slice(0, briefing.indexOf("추적 정보"));

    expect(snapshot.decisions.blockReason).toBe("신규 주문 차단 상태라 신규 진입 판단을 실행하지 않습니다.");
    expect(snapshot.operations.risk).toContain("신규 주문 차단");
    expect(snapshot.operations.risk).not.toContain("operator_pause");
    expect(snapshot.operations.risk).not.toContain("NEW_ORDERS_BLOCKED");
    expect(visibleBriefing).not.toContain("사유 operator_pause");
    expect(visibleBriefing).not.toContain("NEW_ORDERS_BLOCKED");
    expect(snapshot.trace.reasonCodes).toContain("operator_pause");
    expect(snapshot.trace.reasonCodes).toContain("NEW_ORDERS_BLOCKED");
  });

  it("renders reconcile and latest order status as Korean user-facing text", () => {
    const snapshot = createLiveOpsBriefingSnapshot({
      observedAt,
      status: createLiveOpsStatusSummary(liveOpsInput({
        reconcile: {
          result: "FAILED",
          mismatchCount: null,
          openOrderCount: 2,
          lastReconcileAt: observedAt,
          actionRequired: "잔고 조회 복구 후 reconcile을 재실행하세요.",
        },
        latestOrderAttempt: {
          statusLabel: "주문 거절",
          message: "최근 주문 시도는 risk gate에서 차단됐습니다.",
          observedAt,
          action: "risk evidence를 확인하세요.",
          trace: {
            source: "live_order_attempt",
          },
        },
        latestFillOrCancel: {
          statusLabel: "취소 확인",
          message: "최근 주문은 운영자 요청으로 취소됐습니다.",
          observedAt,
          action: null,
          trace: {
            source: "broker_order_status",
          },
        },
      })),
      why: whySummaryFixture(),
    });
    const briefing = formatLiveOpsBriefing(snapshot);
    const visibleBriefing = briefing.slice(0, briefing.indexOf("추적 정보"));

    expect(snapshot.operations.openOrders).toContain("주문 시도: 주문 거절");
    expect(snapshot.operations.openOrders).toContain("체결/취소: 취소 확인");
    expect(snapshot.operations.openOrders).toContain("미체결 주문 2건");
    expect(snapshot.operations.reconcile).toContain("reconcile 확인 실패");
    expect(snapshot.operations.reconcile).not.toContain("FAILED");
    expect(snapshot.operations.risk).not.toContain("NORMAL");
    expect(visibleBriefing).not.toContain("FAILED");
    expect(visibleBriefing).not.toContain("kill switch NORMAL");
    expect(snapshot.trace.reasonCodes).toContain("FAILED");
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

function whySummaryFixture(overrides: {
  markets?: readonly WhyItemFixture[] | undefined;
  strategies?: readonly WhyStrategyItemFixture[] | undefined;
} = {}): WhySummary {
  const markets = overrides.markets ?? [
    {
      market: "KRW-BTC",
      statusLabel: "진입 보류",
      message: "비용 차감 후 기대값이 안전 버퍼를 넘지 못했습니다.",
      latestDecisionAt: observedAt,
      category: "HOLD",
      reasonCode: "entry_hold_cost_margin",
    },
  ];
  const strategies = overrides.strategies ?? [
    {
      strategyId: "exit-small-budget",
      statusLabel: "청산 대기",
      message: "익절과 손절 조건이 모두 충족되지 않았습니다.",
      latestDecisionAt: observedAt,
      category: "HOLD",
      reasonCode: "exit_hold_no_signal",
    },
  ];

  return {
    markets: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "시장별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: markets.map((item) => ({
        market: item.market,
        statusLabel: item.statusLabel,
        message: item.message,
        impact: "신규 매수 후보는 HOLD 상태입니다.",
        action: "스프레드와 호가 깊이를 다시 확인하세요.",
        latestDecisionAt: item.latestDecisionAt,
        trace: {
          category: item.category,
          reasonCode: item.reasonCode,
          ...(item.trace ?? {}),
        },
      })),
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
      items: strategies.map((item) => ({
        strategyId: item.strategyId,
        statusLabel: item.statusLabel,
        message: item.message,
        impact: "기존 포지션은 관측만 계속합니다.",
        action: "exit guard를 유지하세요.",
        latestDecisionAt: item.latestDecisionAt,
        trace: {
          category: item.category,
          reasonCode: item.reasonCode,
        },
      })),
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

function unavailableWhySummaryFixture(): WhySummary {
  return {
    markets: {
      readStatus: "UNAVAILABLE",
      statusLabel: "시장별 판단 이유 조회 불가",
      message: "decision ledger market section을 조회하지 못했습니다.",
      impact: "진입 판단 이유를 확인할 수 없습니다.",
      action: "DB 연결과 decision ledger status provider를 확인하세요.",
      items: [],
      trace: {
        querySource: "decision_ledger_frames",
        reasonCode: "market_why_query_failed",
      },
    },
    strategies: {
      readStatus: "UNAVAILABLE",
      statusLabel: "전략별 판단 이유 조회 불가",
      message: "decision ledger strategy section을 조회하지 못했습니다.",
      impact: "전략 판단 이유를 확인할 수 없습니다.",
      action: "DB 연결과 decision ledger status provider를 확인하세요.",
      items: [],
      trace: {
        querySource: "decision_ledger_frames",
        reasonCode: "strategy_why_query_failed",
      },
    },
    cash: {
      readStatus: "UNAVAILABLE",
      statusLabel: "현금 보유 이유 조회 불가",
      message: "decision ledger cash section을 조회하지 못했습니다.",
      impact: "현금 보유 이유를 확인할 수 없습니다.",
      action: "DB 연결과 decision ledger status provider를 확인하세요.",
      item: null,
      trace: {
        querySource: "decision_ledger_frames",
        reasonCode: "cash_why_query_failed",
      },
    },
    generatedAt: observedAt,
    readStatus: "UNAVAILABLE",
    trace: {
      querySource: "decision_ledger_frames",
      reasonCode: "why_query_failed",
    },
  };
}

function notFoundWhySummaryFixture(): WhySummary {
  return {
    markets: {
      readStatus: "NOT_FOUND",
      statusLabel: "시장별 판단 이유 기록 없음",
      message: "시장별 판단 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      items: [],
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    strategies: {
      readStatus: "NOT_FOUND",
      statusLabel: "전략별 판단 이유 기록 없음",
      message: "전략별 판단 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      items: [],
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    cash: {
      readStatus: "NOT_FOUND",
      statusLabel: "현금 보유 이유 기록 없음",
      message: "현금 보유 이유가 아직 기록되지 않았습니다.",
      impact: null,
      action: "러너를 실행한 뒤 다시 조회하세요.",
      item: null,
      trace: {
        querySource: "decision_ledger_frames",
      },
    },
    generatedAt: observedAt,
    readStatus: "NOT_FOUND",
    trace: {
      querySource: "decision_ledger_frames",
    },
  };
}

interface WhyItemFixture {
  market: string;
  statusLabel: string;
  message: string;
  latestDecisionAt: string;
  category: DecisionCategory;
  reasonCode: string;
  trace?: Record<string, unknown> | undefined;
}

interface WhyStrategyItemFixture {
  strategyId: string;
  statusLabel: string;
  message: string;
  latestDecisionAt: string;
  category: DecisionCategory;
  reasonCode: string;
}
