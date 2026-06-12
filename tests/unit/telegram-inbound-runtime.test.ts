import { describe, expect, it } from "vitest";
import {
  createTelegramInboundCommandRuntime,
  createTelegramInboundPollingRuntime,
  formatTelegramStatusCommandResponse,
  formatTelegramOrdersCommandResponse,
} from "../../src/runtime/index.js";
import {
  FakeTelegramPollingProvider,
  createTelegramReplySender,
  telegramMessageMaxLength,
} from "../../src/infrastructure/index.js";
import {
  createInMemoryTelegramInboundDedupeStore,
  createKillSwitchControlDecision,
  createLiveOpsStatusSummary,
  type AuditEvent,
  type AuditEventReceipt,
  type AuditLogPort,
  type KillSwitchControlProvider,
  type KillSwitchControlResult,
  type TelegramInboundCommandDedupeStore,
  type TelegramInboundCommandMessage,
  type TelegramInboundReplyInput,
  type TelegramInboundReplyPort,
  type TelegramInboundReplyResult,
} from "../../src/application/index.js";
import type { ControlStatusProvider, ControlStatusSnapshot } from "../../src/interfaces/index.js";

const now = "2026-06-10T00:00:00.000Z";

describe("Telegram inbound command runtime", () => {
  it("executes read-only /status through the status provider and replies without raw command text", async () => {
    const fixture = createRuntimeFixture();

    const result = await fixture.runtime.handleMessage(createMessage({ text: "/status" }));

    expect(result).toMatchObject({
      status: "EXECUTED",
      executed: true,
      commandName: "status",
      parseStatus: "PARSED",
      correlationId: "telegram-inbound-10-20",
    });
    expect(fixture.statusProvider.calls).toBe(1);
    expect(fixture.killSwitchProvider.requests).toHaveLength(0);
    expect(fixture.replyPort.replies[0]?.text).toContain("[운영 상태]");
    expect(fixture.replyPort.replies[0]?.text).toContain("거래 상태: 정상 거래 가능");
    expect(JSON.stringify(result)).not.toContain("/status");
    expect(JSON.stringify(fixture.auditLog.events)).not.toContain("/status");
    expect(JSON.stringify(fixture.auditLog.events)).not.toContain('"chatId":"100"');
  });

  it("keeps unauthorized commands audit-only without reply or provider execution", async () => {
    const fixture = createRuntimeFixture();

    const result = await fixture.runtime.handleMessage(createMessage({ chatId: "999", text: "/risk" }));

    expect(result).toMatchObject({
      status: "UNAUTHORIZED",
      executed: false,
      reasonCode: "telegram_inbound_chat_not_allowed",
    });
    expect(fixture.statusProvider.calls).toBe(0);
    expect(fixture.killSwitchProvider.requests).toHaveLength(0);
    expect(fixture.replyPort.replies).toHaveLength(0);
    expect(fixture.auditLog.events).toHaveLength(1);
  });

  it("requires a second matching control command before calling kill switch provider", async () => {
    const fixture = createRuntimeFixture();

    const first = await fixture.runtime.handleMessage(createMessage({ updateId: 11, messageId: 21, text: "/pause" }));
    const second = await fixture.runtime.handleMessage(createMessage({ updateId: 12, messageId: 22, text: "/pause" }));

    expect(first).toMatchObject({
      status: "CONFIRMATION_REQUIRED",
      executed: false,
      commandName: "pause",
      controlConfirmation: {
        status: "PENDING",
      },
    });
    expect(fixture.killSwitchProvider.requests).toHaveLength(1);
    expect(second).toMatchObject({
      status: "EXECUTED",
      executed: true,
      commandName: "pause",
      controlConfirmation: {
        status: "CONFIRMED",
        firstMessageId: 21,
      },
      killSwitchResult: {
        transition: {
          accepted: true,
          toState: "NEW_ORDERS_BLOCKED",
          reasonCode: "operator_pause",
        },
      },
    });
    expect(second.killSwitchResult?.transition.event.metadata).toMatchObject({
      source: "http_control",
      control_request_source: "telegram_inbound_command",
    });
    expect(fixture.killSwitchProvider.requests[0]).toMatchObject({
      targetState: "NEW_ORDERS_BLOCKED",
      reasonCode: "operator_pause",
      actor: "telegram-inbound",
      correlationId: "telegram-inbound-12-22",
      metadata: {
        source: "telegram_inbound_command",
        command: "pause",
      },
    });
    expect(JSON.stringify(fixture.killSwitchProvider.requests[0]?.metadata)).not.toContain('"chatId":"100"');
    expect(fixture.replyPort.replies[0]?.text).toContain("확인 필요");
    expect(fixture.replyPort.replies[1]?.text).toContain("신규 주문 중단");
  });

  it("deduplicates repeated Telegram update/message before provider execution", async () => {
    const fixture = createRuntimeFixture();
    const message = createMessage({ updateId: 13, messageId: 23, text: "/orders" });

    const first = await fixture.runtime.handleMessage(message);
    const second = await fixture.runtime.handleMessage(message);

    expect(first.status).toBe("EXECUTED");
    expect(second).toMatchObject({
      status: "DUPLICATE",
      executed: false,
      reasonCode: "telegram_inbound_duplicate_command",
    });
    expect(fixture.statusProvider.calls).toBe(1);
    expect(fixture.replyPort.replies).toHaveLength(1);
  });

  it("fails closed with audit and reply when dedupe storage is unavailable", async () => {
    const fixture = createRuntimeFixture({
      dedupeStore: {
        async record() {
          throw new Error("jobs unavailable");
        },
      },
    });

    const result = await fixture.runtime.handleMessage(createMessage({ updateId: 14, messageId: 24, text: "/kill" }));

    expect(result).toMatchObject({
      status: "DEDUPE_FAILED",
      executed: false,
      reasonCode: "telegram_inbound_dedupe_failed",
    });
    expect(fixture.statusProvider.calls).toBe(0);
    expect(fixture.killSwitchProvider.requests).toHaveLength(0);
    expect(fixture.auditLog.events).toHaveLength(1);
    expect(fixture.auditLog.events[0]).toMatchObject({
      severity: "ERROR",
      reasonCode: "telegram_inbound_dedupe_failed",
      metadata: {
        outcome: "DEDUPE_FAILED",
        dedupe_status: "failed",
        dedupe_failure_reason: "telegram_inbound_dedupe_failed",
      },
    });
    expect(fixture.replyPort.replies[0]?.text).toContain("중복 실행 보호 상태를 기록하지 못해");
    expect(JSON.stringify(result)).not.toContain("jobs unavailable");
  });

  it("polls fake Telegram updates and returns a safe batch summary with advanced offset", async () => {
    const fixture = createRuntimeFixture();
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 16,
          updates: [createMessage({ updateId: 15, messageId: 25, text: "/pnl" })],
        },
      ]),
      commandRuntime: fixture.runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result).toMatchObject({
      pollingStatus: "ok",
      updateCount: 1,
      providerNextOffset: 16,
      nextOffset: 16,
      handledMessages: [
        {
          status: "EXECUTED",
          commandName: "pnl",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("/pnl");
    expect(pollingRuntime.getCurrentOffset()).toBe(16);
  });

  it("limits formatted command responses to Telegram message length", () => {
    const text = formatTelegramStatusCommandResponse(
      createStatusSnapshot({
        pnl: {
          ...createStatusSnapshot().pnl,
          message: "상태 설명 ".repeat(1_000),
        },
      }),
      "corr-long-status",
    );

    expect(Array.from(text).length).toBeLessThanOrEqual(telegramMessageMaxLength);
    expect(text).toContain("[truncated]");
  });

  it("includes M22 live autonomous exit summary in status and orders responses", () => {
    const snapshot = createStatusSnapshot({
      runtime: {
        ...createStatusSnapshot().runtime,
        liveAutonomous: {
          ...createStatusSnapshot().runtime.liveAutonomous,
          enabled: true,
          ready: true,
          statusLabel: "M22 자동매매 준비",
          message: "M22 guard가 충족됐습니다.",
          action: "제출 전 safety gate를 다시 확인하세요.",
        },
      },
      liveAutonomousExit: {
        ...createStatusSnapshot().liveAutonomousExit,
        enabled: true,
        runtimeReady: true,
        exitEngineReady: true,
        status: "warning",
        statusCode: "REQUOTE_INTENT_CREATED",
        statusLabel: "부분 체결 잔량 재호가 필요",
        message: "청산 주문이 부분 체결되어 미체결 잔량을 취소했고, 남은 수량의 재호가 intent가 생성됐습니다.",
        action: "재호가 intent를 별도 exit 실행 경계에서 제출하세요.",
        remainingQuantity: "0.0004",
      },
    });

    const statusText = formatTelegramStatusCommandResponse(snapshot, "corr-m22-status");
    const ordersText = formatTelegramOrdersCommandResponse(snapshot, "corr-m22-orders");

    expect(statusText).toContain("M22 자동매매: M22 자동매매 준비");
    expect(statusText).toContain("M22 자동 청산: 부분 체결 잔량 재호가 필요");
    expect(statusText).toContain("M22 exit: REQUOTE_INTENT_CREATED");
    expect(ordersText).toContain("M22 자동 청산: 부분 체결 잔량 재호가 필요");
    expect(ordersText).toContain("잔량: 0.0004");
  });

  it("includes M23 live ops summary in /status without exposing raw mode as primary text", () => {
    const base = createStatusSnapshot();
    const text = formatTelegramStatusCommandResponse(
      createStatusSnapshot({
        liveOps: createLiveOpsStatusSummary({
          observedAt: now,
          runtimeMode: "LIVE_AUTONOMOUS_SMALL_BUDGET",
          paperNoKey: false,
          liveTradingEnabled: true,
          liveAutonomous: {
            ...base.runtime.liveAutonomous,
            enabled: true,
            ready: true,
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
          marketData: base.marketData,
          reconcile: {
            result: base.reconcile.result,
            mismatchCount: base.reconcile.mismatchCount,
            openOrderCount: base.reconcile.openOrderCount,
            lastReconcileAt: base.reconcile.lastReconcileAt,
            actionRequired: base.reconcile.actionRequired,
          },
          pnl: {
            statusLabel: base.pnl.statusLabel,
            latestCapturedAt: base.pnl.latestCapturedAt,
            latestEquityKrw: base.pnl.latestEquityKrw,
            latestRealizedPnlKrw: base.pnl.latestRealizedPnlKrw,
            latestUnrealizedPnlKrw: base.pnl.latestUnrealizedPnlKrw,
          },
          tradingState: {
            killSwitchState: base.tradingState.killSwitchState,
            newOrdersBlocked: base.tradingState.newOrdersBlocked,
            requiresManualReview: base.tradingState.requiresManualReview,
            blockedReason: base.tradingState.blockedReason,
          },
          alerts: {
            statusLabel: base.alerts.statusLabel,
            lastSentAt: base.alerts.lastSentAt,
            lastSkippedAt: base.alerts.lastSkippedAt,
            action: base.alerts.action,
          },
        }),
      }),
      "corr-m23-status",
    );

    expect(text).toContain("M23 실매매 운영: 실매매 가능");
    expect(text).toContain("M23 주문 가능: 예");
    expect(text).toContain("필요 조치: 후보 처리 전에도 budget");
    expect(text).toContain("M23 mode: live_order_capable");
    expect(text.split("추적 정보")[0]).not.toContain("live_order_capable");
  });

  it("does not let disabled M22 guidance hide current operational actions", () => {
    const text = formatTelegramStatusCommandResponse(
      createStatusSnapshot({
        pnl: {
          ...createStatusSnapshot().pnl,
          status: "unavailable",
          action: "PnL snapshot provider를 복구하세요.",
        },
      }),
      "corr-disabled-m22",
    );

    expect(text).toContain("필요 조치: PnL snapshot provider를 복구하세요.");
    expect(text).not.toContain("필요 조치: M22를 운영하려면");
  });

  it("does not let healthy M22 guidance hide current operational actions", () => {
    const base = createStatusSnapshot();
    const text = formatTelegramStatusCommandResponse(
      createStatusSnapshot({
        runtime: {
          ...base.runtime,
          liveAutonomous: {
            ...base.runtime.liveAutonomous,
            enabled: true,
            ready: true,
            statusLabel: "M22 자동매매 준비",
            action: "제출 전 safety gate를 다시 확인하세요.",
          },
        },
        liveAutonomousExit: {
          ...base.liveAutonomousExit,
          enabled: true,
          runtimeReady: true,
          exitEngineReady: true,
          status: "ok",
          statusCode: "READY",
          statusLabel: "자동 청산 대기",
          message: "M22 guard와 reconcile 상태가 충족됐고 최근 자동 청산 결과는 없습니다.",
          action: "신규 entry 직전에도 safety gate를 다시 확인하세요.",
        },
        pnl: {
          ...base.pnl,
          status: "unavailable",
          action: "PnL snapshot provider를 복구하세요.",
        },
      }),
      "corr-healthy-m22",
    );

    expect(text).toContain("필요 조치: PnL snapshot provider를 복구하세요.");
    expect(text).not.toContain("필요 조치: 신규 entry 직전");
  });
});

describe("Telegram inbound reply sender", () => {
  it("sends command replies without exposing provider body in the result", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const sender = createTelegramReplySender({
      botToken: "secret-token",
      async fetchImpl(input, init) {
        requests.push({
          url: input,
          body: JSON.parse(String(init.body)),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 99,
              raw_secret_like_field: "secret-token",
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      },
    });

    const result = await sender.sendReply({
      chatId: "100",
      text: "상태: 정상",
      correlationId: "corr-reply",
      replyToMessageId: 20,
    });

    expect(requests[0]?.url).toBe("https://api.telegram.org/botsecret-token/sendMessage");
    expect(requests[0]?.body).toMatchObject({
      chat_id: "100",
      text: "상태: 정상",
      reply_to_message_id: 20,
    });
    expect(result).toEqual({
      delivered: true,
      providerMessageId: "99",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("raw_secret_like_field");
  });
});

function createRuntimeFixture(options: { dedupeStore?: TelegramInboundCommandDedupeStore } = {}) {
  const statusProvider = new CapturingStatusProvider();
  const killSwitchProvider = new CapturingKillSwitchProvider();
  const auditLog = new CapturingAuditLog();
  const replyPort = new CapturingReplyPort();
  const runtime = createTelegramInboundCommandRuntime({
    allowlist: {
      ownerChatIds: ["100"],
      ownerUserIds: ["300"],
    },
    dedupeStore: options.dedupeStore ?? createInMemoryTelegramInboundDedupeStore(() => new Date(now)),
    auditLog,
    replyPort,
    statusProvider,
    killSwitchControlProvider: killSwitchProvider,
    clock: () => new Date(now),
  });

  return {
    runtime,
    statusProvider,
    killSwitchProvider,
    auditLog,
    replyPort,
  };
}

function createMessage(overrides: Partial<TelegramInboundCommandMessage> = {}): TelegramInboundCommandMessage {
  return {
    updateId: 10,
    messageId: 20,
    chatId: "100",
    userId: "300",
    username: "operator",
    text: "/status",
    receivedAt: now,
    ...overrides,
  };
}

class CapturingStatusProvider implements ControlStatusProvider {
  public calls = 0;

  public async getStatus(): Promise<ControlStatusSnapshot> {
    this.calls += 1;
    return createStatusSnapshot();
  }
}

class CapturingKillSwitchProvider implements KillSwitchControlProvider {
  public requests: Array<Parameters<KillSwitchControlProvider["apply"]>[0]> = [];

  public async apply(
    input: Parameters<KillSwitchControlProvider["apply"]>[0],
  ): Promise<KillSwitchControlResult> {
    this.requests.push(input);
    return {
      ...createKillSwitchControlDecision({
        currentState: "NORMAL",
        targetState: input.targetState,
        reasonCode: input.reasonCode,
        correlationId: input.correlationId,
        occurredAt: now,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.message === undefined ? {} : { message: input.message }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }),
      auditEventId: "audit-control-1",
      riskEventId: "risk-control-1",
    };
  }
}

class CapturingAuditLog implements AuditLogPort {
  public events: AuditEvent[] = [];

  public async appendEvent(event: AuditEvent): Promise<AuditEventReceipt> {
    this.events.push(event);
    return {
      auditEventId: `audit-${this.events.length}`,
      appendedAt: now,
    };
  }
}

class CapturingReplyPort implements TelegramInboundReplyPort {
  public replies: TelegramInboundReplyInput[] = [];

  public async sendReply(input: TelegramInboundReplyInput): Promise<TelegramInboundReplyResult> {
    this.replies.push(input);
    return {
      delivered: true,
      providerMessageId: `reply-${this.replies.length}`,
    };
  }
}

function createStatusSnapshot(overrides: Partial<ControlStatusSnapshot> = {}): ControlStatusSnapshot {
  const snapshot: ControlStatusSnapshot = {
    generatedAt: now,
    runtime: {
      exchange: "UPBIT",
      market: "KRW_SPOT",
      mode: "PAPER_TRADING",
      universe: {
        phase1: ["KRW-BTC"],
        phase1Count: 1,
        phase15: {
          enabled: false,
          approvedAltMarkets: [],
          approvedAltCount: 0,
          candidateMarkets: [],
          candidateMarketCount: 0,
          maxManualApprovals: 0,
        },
      },
      liveTradingEnabled: false,
      paperNoKey: true,
      pilot: {
        enabled: false,
        profile: null,
        privateSmokeEnabled: false,
        orderSmokeEnabled: false,
        credentialsConfigured: false,
        keyScopes: [],
        keyScopeEvidenceId: null,
        policySyncMarket: null,
        orderSmokeMarket: null,
        orderSmokeMaxKrw: null,
        lookupOrderConfigured: false,
        statusLabel: "비활성",
        message: "pilot guard가 꺼져 있습니다.",
        action: null,
        lastEvidence: null,
        trace: {},
      },
      liveAutonomous: {
        enabled: false,
        ready: false,
        allowedMarkets: ["KRW-BTC"],
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        maxOpenPositionNotionalKrw: "30000",
        m21WeekGateEvidenceConfigured: false,
        operatorArmEvidenceConfigured: false,
        budgetEvidenceConfigured: false,
        keyScopeEvidenceConfigured: false,
        telegramInboundReady: false,
        reconcileFresh: false,
        pnlStatusReady: false,
        decisionLedgerReady: false,
        exitEngineReady: false,
        statusLabel: "M22 비활성",
        message: "M22 제한적 완전 자동매매가 비활성입니다.",
        action: "필요 시 guard evidence를 갖춘 뒤 arm 절차를 진행하세요.",
        trace: {},
      },
    },
    tradingState: {
      state: "NORMAL",
      killSwitchState: "NORMAL",
      blockedReason: null,
      newOrdersBlocked: false,
      requiresManualReview: false,
    },
    marketData: {
      connectionStatus: "connected",
      lagMs: 50,
      updatedAt: now,
    },
    paper: {
      status: "ok",
      statusLabel: "조회 가능",
      message: "paper 주문과 포지션 집계를 DB에서 읽었다.",
      action: null,
      trace: {},
      pendingPaperOrderCount: 1,
      openPositionCount: 2,
    },
    database: {
      status: "ok",
      ready: true,
      checkedAt: now,
      checks: [],
    },
    alerts: {
      status: "ok",
      statusLabel: "조회 가능",
      message: "alert 상태를 읽었다.",
      action: null,
      trace: {},
      lastSentAt: null,
      lastSkippedAt: null,
    },
    dailyReport: {
      status: "ok",
      statusLabel: "조회 가능",
      message: "daily report 상태를 읽었다.",
      action: null,
      trace: {},
      lastStatus: "COMPLETED",
      reportDate: "2026-06-10",
      nextRunAfter: null,
      updatedAt: now,
    },
    pnl: {
      status: "ok",
      statusLabel: "조회 가능",
      message: "최신 PnL snapshot에서 손익과 평가자산을 읽었다.",
      action: null,
      trace: {},
      latestCapturedAt: now,
      latestEquityKrw: "1000000",
      latestRealizedPnlKrw: "1200",
      latestUnrealizedPnlKrw: "-300",
      latestDrawdownBps: "12",
      latestSource: "pnl_snapshots",
      snapshotCount: 3,
    },
    reconcile: {
      lastReconcileAt: now,
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: 1,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
      actionRequired: "정상",
      message: "거래소-로컬 상태 일치: 모든 미체결 주문과 잔고가 정상입니다.",
      trace: {},
    },
    liveAutonomousExit: {
      enabled: false,
      runtimeReady: false,
      exitEngineReady: false,
      status: "ok",
      statusCode: "DISABLED",
      statusLabel: "M22 자동 청산 비활성",
      message: "M22 자동매매가 비활성이라 live autonomous exit 연결도 실행하지 않습니다.",
      impact: "실계좌 주문 side effect가 생성되지 않습니다.",
      action: "M22를 운영하려면 guard evidence와 readiness를 갖춘 뒤 별도 arm 절차를 진행하세요.",
      market: null,
      strategyId: null,
      latestBrokerOrderStatus: null,
      filledQuantity: null,
      remainingQuantity: null,
      reconcile: {
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 1,
        balanceStatus: "OK",
        websocketStatus: "CONNECTED",
        lastReconcileAt: now,
      },
      trace: {},
    },
    why: {
      readStatus: "OK",
      generatedAt: now,
      trace: {},
      markets: {
        readStatus: "OK",
        statusLabel: "조회 완료",
        message: "시장별 최근 판단 이유를 조회했습니다.",
        impact: null,
        action: null,
        trace: {},
        items: [
          {
            market: "KRW-BTC",
            statusLabel: "보류",
            message: "비용 차감 후 기대값이 부족해 주문을 보류했습니다.",
            impact: "신규 주문 없음",
            action: "다음 frame을 기다리세요.",
            latestDecisionAt: now,
            trace: {},
          },
        ],
      },
      strategies: {
        readStatus: "NOT_FOUND",
        statusLabel: "기록 없음",
        message: "전략별 판단 이유가 아직 기록되지 않았습니다.",
        impact: null,
        action: "러너를 실행한 뒤 다시 조회하세요.",
        trace: {},
        items: [],
      },
      cash: {
        readStatus: "OK",
        statusLabel: "조회 완료",
        message: "현금 보유 이유를 조회했습니다.",
        impact: null,
        action: null,
        trace: {},
        item: {
          statusLabel: "현금 보유",
          message: "현재 주문 후보가 없어 현금을 보유합니다.",
          impact: "신규 주문 없음",
          action: null,
          latestDecisionAt: now,
          holdReasons: [
            {
              label: "비용 우위 부족",
              count: 2,
              trace: {
                reasonCode: "cost_margin_insufficient",
              },
            },
          ],
          trace: {},
        },
      },
    },
  };

  return {
    ...snapshot,
    ...overrides,
  };
}
