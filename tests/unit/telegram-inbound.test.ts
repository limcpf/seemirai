import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeTelegramPollingProvider,
  createTelegramGetUpdatesPollingProvider,
} from "../../src/infrastructure/index.js";
import {
  UnsafeTelegramInboundConfigError,
  loadRuntimeConfig,
  loadRuntimeTelegramInboundConfig,
} from "../../src/runtime/index.js";
import {
  createInMemoryTelegramInboundDedupeStore,
  createTelegramInboundCommandAuditEvent,
  createTelegramInboundCommandIdempotencyKey,
  evaluateTelegramInboundAuthorization,
  hashTelegramInboundIdentifier,
  parseTelegramInboundCommand,
  telegramInboundCommandJobType,
} from "../../src/application/index.js";

describe("Telegram inbound foundation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps inbound polling disabled by default and requires explicit guards", () => {
    const config = loadRuntimeConfig({});

    expect(loadRuntimeTelegramInboundConfig(config, {})).toEqual({
      enabled: false,
      reasonCode: "telegram_inbound_disabled",
    });

    expect(() =>
      loadRuntimeTelegramInboundConfig(config, {
        SEEMIRAI_TELEGRAM_INBOUND_ENABLED: "1",
        SEEMIRAI_TELEGRAM_BOT_TOKEN: "secret-token",
      }),
    ).toThrow(UnsafeTelegramInboundConfigError);

    expect(
      loadRuntimeTelegramInboundConfig(config, {
        SEEMIRAI_TELEGRAM_INBOUND_ENABLED: "1",
        SEEMIRAI_TELEGRAM_BOT_TOKEN: "secret-token",
        SEEMIRAI_TELEGRAM_INBOUND_BOT_USERNAME: "SeemiraiOpsBot",
        SEEMIRAI_TELEGRAM_INBOUND_OWNER_CHAT_IDS: "100, 200",
        SEEMIRAI_TELEGRAM_INBOUND_OWNER_USER_IDS: "300",
        SEEMIRAI_TELEGRAM_INBOUND_POLLING_INTERVAL_MS: "2500",
      }),
    ).toMatchObject({
      enabled: true,
      botToken: "secret-token",
      botUsername: "SeemiraiOpsBot",
      ownerChatIds: ["100", "200"],
      ownerUserIds: ["300"],
      providerTimeoutMs: 5_000,
      pollingIntervalMs: 2_500,
      pollingTimeoutSeconds: 20,
      maxUpdatesPerPoll: 50,
    });
  });

  it("parses read-only and control commands with Korean malformed guidance", () => {
    expect(parseTelegramInboundCommand("/status")).toEqual({
      status: "PARSED",
      command: {
        name: "status",
        scope: "READ_ONLY",
        normalizedText: "/status",
      },
    });
    expect(parseTelegramInboundCommand("/why krw-btc")).toEqual({
      status: "PARSED",
      command: {
        name: "why",
        scope: "READ_ONLY",
        normalizedText: "/why KRW-BTC",
        argument: {
          kind: "market",
          market: "KRW-BTC",
        },
      },
    });
    expect(parseTelegramInboundCommand("/kill")).toEqual({
      status: "PARSED",
      command: {
        name: "kill",
        scope: "CONTROL",
        normalizedText: "/kill",
      },
    });
    expect(parseTelegramInboundCommand("/status@SeemiraiOpsBot", { botUsername: "seemiraiopsbot" })).toEqual({
      status: "PARSED",
      command: {
        name: "status",
        scope: "READ_ONLY",
        normalizedText: "/status",
      },
    });
    expect(parseTelegramInboundCommand("/kill@OtherBot", { botUsername: "SeemiraiOpsBot" })).toMatchObject({
      status: "UNKNOWN",
      reasonCode: "telegram_command_bot_mention_mismatch",
      userMessage: "다른 Telegram bot을 향한 명령이거나 bot username 확인이 없어 요청을 실행하지 않았습니다.",
    });
    expect(parseTelegramInboundCommand("/pause@SeemiraiOpsBot")).toMatchObject({
      status: "UNKNOWN",
      reasonCode: "telegram_command_bot_username_unconfigured",
    });
    expect(parseTelegramInboundCommand("/why")).toMatchObject({
      status: "MALFORMED",
      reasonCode: "telegram_why_target_required",
      userMessage: "판단 이유를 보려면 /why KRW-BTC 또는 /why cash처럼 대상을 함께 입력해 주세요.",
    });
    expect(parseTelegramInboundCommand("/approve proposal-001")).toEqual({
      status: "PARSED",
      command: {
        name: "approve",
        scope: "APPROVAL",
        normalizedText: "/approve proposal-001",
        argument: {
          kind: "proposal",
          proposalId: "proposal-001",
        },
      },
    });
    expect(parseTelegramInboundCommand("/reject proposal-001")).toMatchObject({
      status: "PARSED",
      command: {
        name: "reject",
        scope: "APPROVAL",
        argument: {
          kind: "proposal",
          proposalId: "proposal-001",
        },
      },
    });
    expect(parseTelegramInboundCommand("/approve")).toMatchObject({
      status: "MALFORMED",
      reasonCode: "telegram_approval_proposal_id_required",
    });
    expect(parseTelegramInboundCommand("/approve proposal-001 extra")).toMatchObject({
      status: "MALFORMED",
      reasonCode: "telegram_approval_proposal_id_invalid",
    });
  });

  it("checks owner allowlist before dispatch and hashes identifiers for evidence", () => {
    expect(
      evaluateTelegramInboundAuthorization(
        {
          chatId: "100",
          userId: "300",
        },
        {
          ownerChatIds: ["100"],
          ownerUserIds: ["300"],
        },
      ),
    ).toEqual({
      ok: true,
      reasonCode: "telegram_inbound_authorized",
    });
    expect(
      evaluateTelegramInboundAuthorization(
        {
          chatId: "999",
          userId: "300",
        },
        {
          ownerChatIds: ["100"],
          ownerUserIds: ["300"],
        },
      ),
    ).toMatchObject({
      ok: false,
      reasonCode: "telegram_inbound_chat_not_allowed",
      userMessage: "허용된 운영자 채팅이 아니어서 Telegram 명령을 실행하지 않았습니다.",
    });
    expect(hashTelegramInboundIdentifier("100")).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("creates deterministic dedupe keys and blocks repeated command execution", async () => {
    const parseResult = parseTelegramInboundCommand("/pause");
    expect(parseResult.status).toBe("PARSED");
    if (parseResult.status !== "PARSED") {
      throw new Error("fixture command must parse");
    }

    const idempotencyKey = createTelegramInboundCommandIdempotencyKey({
      message: {
        updateId: 10,
        messageId: 20,
        chatId: "100",
      },
      command: parseResult.command,
    });
    const store = createInMemoryTelegramInboundDedupeStore(
      () => new Date("2026-06-10T00:00:00.000Z"),
    );

    expect(idempotencyKey).toMatch(/^telegram\.inbound\.v1:update:10:message:20:chat:/u);
    await expect(
      store.record({
        idempotencyKey,
        occurredAt: "2026-06-10T00:00:00.000Z",
        metadata: {
          job_type: telegramInboundCommandJobType,
        },
      }),
    ).resolves.toMatchObject({
      duplicate: false,
      store: "memory",
    });
    await expect(
      store.record({
        idempotencyKey,
        occurredAt: "2026-06-10T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      duplicate: true,
      store: "memory",
    });
  });

  it("builds audit evidence without raw Telegram text or raw chat id", () => {
    const parseResult = parseTelegramInboundCommand("/why cash");
    const authorization = evaluateTelegramInboundAuthorization(
      {
        chatId: "100",
        userId: "300",
      },
      {
        ownerChatIds: ["100"],
      },
    );
    const event = createTelegramInboundCommandAuditEvent({
      message: {
        updateId: 10,
        messageId: 20,
        chatId: "100",
        userId: "300",
        receivedAt: "2026-06-10T00:00:00.000Z",
      },
      parseResult,
      authorization,
      dedupe: {
        idempotencyKey: "telegram.inbound.v1:update:10",
        duplicate: false,
        storedAt: "2026-06-10T00:00:00.000Z",
        store: "memory",
      },
    });

    expect(event).toMatchObject({
      eventType: "TELEGRAM_INBOUND_COMMAND",
      severity: "INFO",
      actor: "telegram_inbound",
      reasonCode: "telegram_inbound_command_accepted",
      metadata: {
        audit_kind: "TELEGRAM_INBOUND_COMMAND",
        transport: "polling",
        outcome: "AUTHORIZED",
        command: "why",
        command_scope: "READ_ONLY",
        command_target: "cash",
        dedupe_duplicate: false,
      },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("/why cash");
    expect(serialized).not.toContain('"chatId":"100"');
    expect(serialized).not.toContain('"chat_id":"100"');
    expect(serialized).not.toContain("secret-token");
  });

  it("projects Telegram getUpdates responses without exposing raw provider payload", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const provider = createTelegramGetUpdatesPollingProvider({
      botToken: "secret-token",
      async fetchImpl(input, init) {
        requests.push({ url: input, init });
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 20,
                  date: 1_781_049_600,
                  text: "/status",
                  chat: {
                    id: 100,
                    type: "private",
                  },
                  from: {
                    id: 300,
                    username: "operator",
                    first_name: "raw-name-not-used",
                  },
                },
                raw_secret_like_field: "secret-token",
              },
            ],
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

    const result = await provider.getUpdates({
      offset: 9,
      timeoutSeconds: 20,
      limit: 50,
    });

    expect(requests[0]?.url).toBe("https://api.telegram.org/botsecret-token/getUpdates");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      offset: 9,
      timeout: 20,
      limit: 50,
      allowed_updates: ["message"],
    });
    expect(result).toEqual({
      status: "ok",
      nextOffset: 11,
      updates: [
        {
          updateId: 10,
          messageId: 20,
          chatId: "100",
          userId: "300",
          username: "operator",
          text: "/status",
          receivedAt: "2026-06-10T00:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("raw_secret_like_field");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("keeps provider abort timeout longer than Telegram long polling timeout", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const provider = createTelegramGetUpdatesPollingProvider({
      botToken: "secret-token",
      providerTimeoutMs: 5_000,
      async fetchImpl(_input, init) {
        capturedSignal = init.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      },
    });

    const resultPromise = provider.getUpdates({
      timeoutSeconds: 20,
      limit: 50,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_999);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(resultPromise).resolves.toEqual({
      status: "failed",
      reasonCode: "telegram_get_updates_timeout",
    });
  });

  it("supports fake polling batches for integration wiring tests", async () => {
    const provider = new FakeTelegramPollingProvider([
      {
        status: "failed",
        reasonCode: "telegram_get_updates_timeout",
      },
      {
        status: "ok",
        updates: [],
        nextOffset: null,
      },
    ]);

    await expect(
      provider.getUpdates({
        timeoutSeconds: 20,
        limit: 50,
      }),
    ).resolves.toEqual({
      status: "failed",
      reasonCode: "telegram_get_updates_timeout",
    });
    await expect(
      provider.getUpdates({
        timeoutSeconds: 20,
        limit: 50,
      }),
    ).resolves.toEqual({
      status: "ok",
      updates: [],
      nextOffset: null,
    });
  });
});
