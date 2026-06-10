import { describe, expect, it } from "vitest";
import {
  createInMemoryTelegramInboundDedupeStore,
  type AuditEvent,
  type AuditLogPort,
  type BrokerPort,
  type KillSwitchControlProvider,
  type TelegramInboundReplyInput,
  type TelegramInboundReplyPort,
} from "../../src/application/index.js";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  LiveOrderProposalContract,
  OrderSubmission,
} from "../../src/domain/index.js";
import { FakeTelegramPollingProvider } from "../../src/infrastructure/index.js";
import {
  createInMemoryLiveOrderApprovalProposalStore,
  createLiveOrderApprovalCommandRuntime,
  createTelegramInboundCommandRuntime,
  createTelegramInboundPollingRuntime,
  loadRuntimeConfig,
  type LiveOrderApprovalSubmissionRecheckProvider,
  type LiveOrderApprovalSubmissionRecheckSnapshot,
} from "../../src/runtime/index.js";

const now = "2026-06-10T00:00:00.000Z";

describe("M21 Telegram live order approval runtime", () => {
  it("승인된 proposal만 fake broker로 제출하고 동일 Telegram update 재전달은 중복 주문을 만들지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([createProposal()]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 12,
          updates: [
            {
              updateId: 10,
              messageId: 20,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-001",
              receivedAt: now,
            },
            {
              updateId: 10,
              messageId: 20,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-001",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result).toMatchObject({
      pollingStatus: "ok",
      handledMessages: [
        {
          status: "EXECUTED",
          executed: true,
          commandName: "approve",
          liveOrderApprovalResult: {
            status: "APPROVAL_SUBMITTED",
            brokerSubmitted: true,
          },
        },
        {
          status: "DUPLICATE",
          executed: false,
          reasonCode: "telegram_inbound_duplicate_command",
        },
      ],
    });
    expect(broker.submissions).toHaveLength(1);
    expect(broker.submissions[0]).toMatchObject({
      intent: {
        idempotencyKey: "m21-proposal-001",
        market: "KRW-BTC",
        orderType: "LIMIT",
        metadata: {
          live_order_proposal_id: "proposal-001",
          approval_mode: "LIVE_ARMED_MANUAL_APPROVAL",
        },
      },
    });
    expect(proposalStore.listEvidence("proposal-001").map((event) => event.evidenceKind)).toEqual([
      "APPROVAL_RECORDED",
      "SUBMISSION_RECHECK_PASSED",
      "BROKER_SUBMISSION_RECORDED",
    ]);
    expect(auditEvents.filter((event) => event.eventType === "LIVE_ORDER_APPROVAL")).toHaveLength(3);
    expect(replies[0]?.text).toContain("live 주문 제출까지 완료했습니다");
    expect(JSON.stringify(auditEvents)).not.toContain("/approve proposal-001");
    expect(JSON.stringify(result)).not.toContain('"chatId":"100"');
  });

  it("제출 직전 recheck가 실패하면 approval evidence와 failure evidence만 남기고 broker를 호출하지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([createProposal({ proposalId: "proposal-blocked" })]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider({
        riskApproved: false,
      }),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 31,
          updates: [
            {
              updateId: 30,
              messageId: 40,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-blocked",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "APPROVAL_SUBMISSION_BLOCKED",
        brokerSubmitted: false,
        trace: {
          violations: ["m21_risk_not_approved"],
        },
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-blocked").map((event) => event.evidenceKind)).toEqual([
      "APPROVAL_RECORDED",
      "SUBMISSION_FAILURE_RECORDED",
    ]);
    expect(replies[0]?.text).toContain("제출 직전 재검증이 실패");
    expect(readOperatorFacingText(replies[0]?.text)).not.toContain("m21_risk_not_approved");
    expect(auditEvents.filter((event) => event.eventType === "LIVE_ORDER_APPROVAL")).toHaveLength(2);
  });

  it("승인 evidence audit append가 실패하면 broker 제출 전에 failure evidence로 닫는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([
      createProposal({ proposalId: "proposal-audit-blocked" }),
    ]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
      failLiveApprovalAudit: true,
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 36,
          updates: [
            {
              updateId: 35,
              messageId: 45,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-audit-blocked",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "APPROVAL_SUBMISSION_BLOCKED",
        brokerSubmitted: false,
        reasonCode: "m21_approval_audit_append_failed",
        trace: {
          violations: ["m21_approval_audit_append_failed"],
        },
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-audit-blocked").map((event) => event.evidenceKind)).toEqual([
      "APPROVAL_RECORDED",
      "SUBMISSION_FAILURE_RECORDED",
    ]);
    expect(auditEvents.filter((event) => event.eventType === "LIVE_ORDER_APPROVAL")).toHaveLength(0);
    expect(replies[0]?.text).toContain("승인 evidence 감사 기록을 완료하지 못했습니다");
    expect(readOperatorFacingText(replies[0]?.text)).not.toContain("m21_approval_audit_append_failed");
  });

  it("Telegram backlog 메시지는 메시지 시각이 아니라 처리 시각으로 만료를 판단한다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([createProposal({ proposalId: "proposal-backlog" })]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
      processingNow: "2026-06-10T00:10:00.000Z",
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 38,
          updates: [
            {
              updateId: 37,
              messageId: 47,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-backlog",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "PROPOSAL_EXPIRED",
        brokerSubmitted: false,
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-backlog")).toMatchObject([
      {
        evidenceKind: "EXPIRATION_RECORDED",
        occurredAt: "2026-06-10T00:10:00.000Z",
        metadata: {
          telegram_message_received_at: now,
        },
      },
    ]);
  });

  it("제출 가격과 수량으로 재계산한 금액이 proposal 금액과 다르면 broker를 호출하지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([
      createProposal({
        proposalId: "proposal-notional-mismatch",
        requestedVolume: "10",
      }),
    ]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 39,
          updates: [
            {
              updateId: 38,
              messageId: 48,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-notional-mismatch",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "APPROVAL_SUBMISSION_BLOCKED",
        brokerSubmitted: false,
        trace: {
          violations: expect.arrayContaining(["m21_order_notional_mismatch"]),
        },
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-notional-mismatch").map((event) => event.evidenceKind)).toEqual([
      "APPROVAL_RECORDED",
      "SUBMISSION_FAILURE_RECORDED",
    ]);
    expect(replies[0]?.text).toContain("proposal 금액과 실제 제출 가격·수량으로 계산한 금액이 일치하지 않습니다");
    expect(readOperatorFacingText(replies[0]?.text)).not.toContain("m21_order_notional_mismatch");
  });

  it("최종 broker submission audit append가 실패하면 제출된 주문을 성공 상태로 숨기지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([
      createProposal({
        proposalId: "proposal-submitted-audit-fail",
        idempotencyKey: "m21-final-audit-fail",
      }),
    ]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
      failLiveApprovalAudit: "broker_submission",
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 40,
          updates: [
            {
              updateId: 39,
              messageId: 49,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-submitted-audit-fail",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "APPROVAL_SUBMISSION_FAILED",
        brokerSubmitted: true,
        reasonCode: "m21_broker_submission_audit_append_failed",
      },
    });
    expect(broker.submissions).toHaveLength(1);
    expect(proposalStore.listEvidence("proposal-submitted-audit-fail").map((event) => event.evidenceKind)).toEqual([
      "APPROVAL_RECORDED",
      "SUBMISSION_RECHECK_PASSED",
      "BROKER_SUBMISSION_RECORDED",
    ]);
    expect(auditEvents.filter((event) => event.eventType === "LIVE_ORDER_APPROVAL")).toHaveLength(2);
    expect(replies[0]?.text).toContain("최종 audit 기록을 완료하지 못했습니다");
  });

  it("만료된 proposal 승인은 expiration evidence만 남기고 broker를 호출하지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([
      createProposal({
        proposalId: "proposal-expired",
        expiresAt: "2026-06-09T23:59:00.000Z",
      }),
    ]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 41,
          updates: [
            {
              updateId: 40,
              messageId: 50,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-expired",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "PROPOSAL_EXPIRED",
        brokerSubmitted: false,
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-expired").map((event) => event.evidenceKind)).toEqual([
      "EXPIRATION_RECORDED",
    ]);
    expect(replies[0]?.text).toContain("만료로 기록");
  });

  it("이미 제출된 proposal 재승인은 상태를 바꾸지 않고 broker를 호출하지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([
      createProposal({
        proposalId: "proposal-submitted",
        status: "SUBMITTED",
      }),
    ]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 61,
          updates: [
            {
              updateId: 60,
              messageId: 70,
              chatId: "100",
              userId: "300",
              text: "/approve proposal-submitted",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: false,
      liveOrderApprovalResult: {
        status: "PROPOSAL_NOT_APPROVABLE",
        brokerSubmitted: false,
        stateChanged: false,
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-submitted")).toHaveLength(0);
    expect(replies[0]?.text).toContain("이미 닫힌 proposal");
  });

  it("거부 command는 rejection evidence만 남기고 broker를 호출하지 않는다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const proposalStore = createInMemoryLiveOrderApprovalProposalStore([createProposal({ proposalId: "proposal-reject" })]);
    const broker = new FakeBroker();
    const runtime = createTelegramRuntime({
      auditEvents,
      replies,
      proposalStore,
      broker,
      recheckProvider: new FakeRecheckProvider(),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 51,
          updates: [
            {
              updateId: 50,
              messageId: 60,
              chatId: "100",
              userId: "300",
              text: "/reject proposal-reject",
              receivedAt: now,
            },
          ],
        },
      ]),
      commandRuntime: runtime,
      pollingIntervalMs: 1_000,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });

    const result = await pollingRuntime.runOnce();

    expect(result.handledMessages[0]).toMatchObject({
      status: "EXECUTED",
      executed: true,
      liveOrderApprovalResult: {
        status: "REJECTION_RECORDED",
        brokerSubmitted: false,
      },
    });
    expect(broker.submissions).toHaveLength(0);
    expect(proposalStore.listEvidence("proposal-reject").map((event) => event.evidenceKind)).toEqual([
      "REJECTION_RECORDED",
    ]);
    expect(replies[0]?.text).toContain("운영자 거부를 기록");
  });
});

function createTelegramRuntime(options: {
  auditEvents: AuditEvent[];
  replies: TelegramInboundReplyInput[];
  proposalStore: ReturnType<typeof createInMemoryLiveOrderApprovalProposalStore>;
  broker: FakeBroker;
  recheckProvider: LiveOrderApprovalSubmissionRecheckProvider;
  failLiveApprovalAudit?: boolean | "broker_submission";
  processingNow?: string;
}) {
  const auditLog = {
    async appendEvent(event) {
      const evidenceKind = event.metadata?.evidence_kind;
      if (
        event.eventType === "LIVE_ORDER_APPROVAL" &&
        (options.failLiveApprovalAudit === true ||
          (options.failLiveApprovalAudit === "broker_submission" && evidenceKind === "BROKER_SUBMISSION_RECORDED"))
      ) {
        throw new Error("fake live approval audit append failure");
      }

      options.auditEvents.push(event);
      return {
        auditEventId: `audit-${options.auditEvents.length}`,
        appendedAt: now,
      };
    },
  } satisfies AuditLogPort;

  return createTelegramInboundCommandRuntime({
    allowlist: {
      ownerChatIds: ["100"],
      ownerUserIds: ["300"],
    },
    dedupeStore: createInMemoryTelegramInboundDedupeStore(() => new Date(now)),
    auditLog,
    replyPort: {
      async sendReply(input) {
        options.replies.push(input);
        return {
          delivered: true,
          providerMessageId: `reply-${options.replies.length}`,
        };
      },
    } satisfies TelegramInboundReplyPort,
    statusProvider: {
      async getStatus() {
        throw new Error("approval command must not call status provider");
      },
    },
    killSwitchControlProvider: {
      async apply() {
        throw new Error("approval command must not call kill switch control provider");
      },
    } satisfies KillSwitchControlProvider,
    liveOrderApprovalRuntime: createLiveOrderApprovalCommandRuntime({
      config: loadRuntimeConfig({
        live_manual_approval: {
          enabled: true,
        },
      }).live_manual_approval,
      proposalStore: options.proposalStore,
      recheckProvider: options.recheckProvider,
      broker: options.broker,
      auditLog,
      clock: () => new Date(options.processingNow ?? now),
    }),
    clock: () => new Date(options.processingNow ?? now),
  });
}

function readOperatorFacingText(text: string | undefined): string {
  return text?.split("\n\n추적 정보")[0] ?? "";
}

class FakeRecheckProvider implements LiveOrderApprovalSubmissionRecheckProvider {
  private readonly overrides: Partial<LiveOrderApprovalSubmissionRecheckSnapshot>;

  public constructor(overrides: Partial<LiveOrderApprovalSubmissionRecheckSnapshot> = {}) {
    this.overrides = overrides;
  }

  public async getSubmissionRecheckSnapshot(): Promise<LiveOrderApprovalSubmissionRecheckSnapshot> {
    return {
      observedAt: now,
      riskApproved: true,
      riskDecisionId: "risk-decision-001",
      riskApproval: {
        source: "risk_gate",
        approved: true,
        action: "ALLOW",
        status: "PASS",
      },
      killSwitchAllowsNewOrders: true,
      reconcileFresh: true,
      dailyApprovedNotionalUsedKrw: "0",
      referencePrice: "100000",
      ...this.overrides,
    };
  }
}

class FakeBroker implements BrokerPort {
  public readonly submissions: OrderSubmission[] = [];

  public async submitOrder(order: OrderSubmission): Promise<BrokerOrder> {
    this.submissions.push(order);
    return {
      brokerOrderId: `broker-order-${this.submissions.length}`,
      idempotencyKey: order.intent.idempotencyKey,
      exchangeId: order.intent.exchangeId,
      market: order.intent.market,
      side: order.intent.side,
      orderType: order.intent.orderType,
      status: "ACCEPTED",
      requestedQuantity: order.intent.requestedQuantity,
      remainingQuantity: order.intent.requestedQuantity,
      ...(order.intent.requestedPrice === undefined ? {} : { requestedPrice: order.intent.requestedPrice }),
      acceptedAt: now,
      updatedAt: now,
      metadata: {
        fake: true,
      },
    };
  }

  public async cancelOrder(): Promise<BrokerOrder> {
    throw new Error("cancelOrder is outside M21 approval runtime scope");
  }

  public async getOrder(): Promise<BrokerOrder | undefined> {
    return undefined;
  }

  public async listOpenOrders(): Promise<readonly BrokerOrder[]> {
    return [];
  }

  public async getBalances(): Promise<BrokerBalanceSnapshot> {
    return {
      exchangeId: "upbit_krw_spot",
      balances: [],
      capturedAt: now,
    };
  }
}

function createProposal(overrides: Partial<LiveOrderProposalContract> = {}): LiveOrderProposalContract {
  const proposalId = overrides.proposalId ?? "proposal-001";
  return {
    proposalId,
    status: "PROPOSED",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "100000",
    requestedVolume: "0.1",
    expectedNotionalKrw: "10000",
    idempotencyKey: `m21-${proposalId}`,
    decisionLedgerId: "decision-ledger-001",
    riskDecisionId: "risk-decision-001",
    costSnapshot: {
      source: "cost_model",
      trade_allowed: true,
    },
    budget: {
      configuredMaxOrderKrw: "10000",
      dailyApprovedNotionalLimitKrw: "30000",
      dailyApprovedNotionalUsedKrw: "0",
      capturedAt: now,
    },
    operatorFacingSummary: {
      title: "승인이 필요한 주문 후보입니다.",
      body: "KRW-BTC 지정가 매수 후보가 비용과 리스크 기준을 통과했습니다.",
      action: `/approve ${proposalId} 또는 /reject ${proposalId} 로 처리해 주세요.`,
    },
    proposedAt: now,
    expiresAt: "2026-06-10T00:05:00.000Z",
    metadata: {
      strategy_id: "trend_following",
    },
    ...overrides,
  };
}
