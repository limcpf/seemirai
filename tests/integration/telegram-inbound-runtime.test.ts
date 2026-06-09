import { describe, expect, it } from "vitest";
import {
  createInMemoryTelegramInboundDedupeStore,
  createKillSwitchControlDecision,
  type AuditEvent,
  type AuditLogPort,
  type KillSwitchControlProvider,
  type TelegramInboundReplyInput,
  type TelegramInboundReplyPort,
} from "../../src/application/index.js";
import { FakeTelegramPollingProvider } from "../../src/infrastructure/index.js";
import {
  createTelegramInboundCommandRuntime,
  createTelegramInboundPollingRuntime,
} from "../../src/runtime/index.js";

const now = "2026-06-10T00:00:00.000Z";

describe("Telegram inbound fake polling integration", () => {
  it("polling batch에서 control confirmation, duplicate 차단, unauthorized audit-only를 함께 처리한다", async () => {
    const auditEvents: AuditEvent[] = [];
    const replies: TelegramInboundReplyInput[] = [];
    const controlRequests: Array<Parameters<KillSwitchControlProvider["apply"]>[0]> = [];
    const runtime = createTelegramInboundCommandRuntime({
      allowlist: {
        ownerChatIds: ["100"],
        ownerUserIds: ["300"],
      },
      dedupeStore: createInMemoryTelegramInboundDedupeStore(() => new Date(now)),
      auditLog: {
        async appendEvent(event) {
          auditEvents.push(event);
          return {
            auditEventId: `audit-${auditEvents.length}`,
            appendedAt: now,
          };
        },
      } satisfies AuditLogPort,
      replyPort: {
        async sendReply(input) {
          replies.push(input);
          return {
            delivered: true,
            providerMessageId: `reply-${replies.length}`,
          };
        },
      } satisfies TelegramInboundReplyPort,
      statusProvider: {
        async getStatus() {
          throw new Error("status provider should not be called by this control-only batch");
        },
      },
      killSwitchControlProvider: {
        async apply(input) {
          controlRequests.push(input);
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
        },
      },
      clock: () => new Date(now),
    });
    const pollingRuntime = createTelegramInboundPollingRuntime({
      pollingProvider: new FakeTelegramPollingProvider([
        {
          status: "ok",
          nextOffset: 23,
          updates: [
            {
              updateId: 20,
              messageId: 30,
              chatId: "100",
              userId: "300",
              text: "/pause",
              receivedAt: now,
            },
            {
              updateId: 21,
              messageId: 31,
              chatId: "100",
              userId: "300",
              text: "/pause",
              receivedAt: now,
            },
            {
              updateId: 21,
              messageId: 31,
              chatId: "100",
              userId: "300",
              text: "/pause",
              receivedAt: now,
            },
            {
              updateId: 22,
              messageId: 32,
              chatId: "999",
              userId: "300",
              text: "/kill",
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
      updateCount: 4,
      providerNextOffset: 23,
      nextOffset: 23,
      handledMessages: [
        {
          status: "CONFIRMATION_REQUIRED",
          executed: false,
          commandName: "pause",
        },
        {
          status: "EXECUTED",
          executed: true,
          commandName: "pause",
        },
        {
          status: "DUPLICATE",
          executed: false,
          reasonCode: "telegram_inbound_duplicate_command",
        },
        {
          status: "UNAUTHORIZED",
          executed: false,
          reasonCode: "telegram_inbound_chat_not_allowed",
        },
      ],
    });
    expect(controlRequests).toHaveLength(1);
    expect(controlRequests[0]).toMatchObject({
      targetState: "NEW_ORDERS_BLOCKED",
      reasonCode: "operator_pause",
      actor: "telegram-inbound",
      correlationId: "telegram-inbound-21-31",
      metadata: {
        source: "telegram_inbound_command",
        command: "pause",
      },
    });
    expect(replies).toHaveLength(2);
    expect(replies[0]?.text).toContain("확인 필요");
    expect(replies[1]?.text).toContain("신규 주문 중단");
    expect(auditEvents.map((event) => event.metadata?.outcome)).toEqual([
      "AUTHORIZED",
      "AUTHORIZED",
      "DUPLICATE",
      "UNAUTHORIZED",
    ]);
    expect(JSON.stringify(result)).not.toContain("/pause");
    expect(JSON.stringify(auditEvents)).not.toContain("/kill");
    expect(JSON.stringify(auditEvents)).not.toContain('"chatId":"100"');
    expect(JSON.stringify(auditEvents)).not.toContain('"chat_id":"100"');
  });
});
