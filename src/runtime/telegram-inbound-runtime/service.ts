import {
  createTelegramInboundCommandAuditEvent,
  createTelegramInboundCommandIdempotencyKey,
  evaluateTelegramInboundAuthorization,
  hashTelegramInboundIdentifier,
  parseTelegramInboundCommand,
  telegramInboundCommandJobType,
} from "../../application/index.js";
import type {
  AuditEventReceipt,
  ParsedTelegramInboundCommand,
  TelegramInboundCommandDedupeResult,
  TelegramInboundCommandMessage,
  TelegramInboundReplyResult,
} from "../../application/index.js";
import type { KillSwitchControlTargetState } from "../../application/index.js";
import type { JsonRecord } from "../../domain/index.js";
import {
  formatTelegramAuditFailureResponse,
  formatTelegramCommandExecutionFailureResponse,
  formatTelegramControlCommandResponse,
  formatTelegramControlConfirmationRequiredResponse,
  formatTelegramDedupeFailureResponse,
  formatTelegramOrdersCommandResponse,
  formatTelegramPnlCommandResponse,
  formatTelegramPositionsCommandResponse,
  formatTelegramRiskCommandResponse,
  formatTelegramStatusCommandResponse,
  formatTelegramWhyCommandResponse,
} from "./formatter.js";
import type {
  TelegramInboundCommandHandleResult,
  TelegramInboundCommandRuntime,
  TelegramInboundCommandRuntimeOptions,
  TelegramInboundControlConfirmationInput,
  TelegramInboundControlConfirmationResult,
  TelegramInboundControlConfirmationStore,
  TelegramInboundPollingRunOnceResult,
  TelegramInboundPollingRuntime,
  TelegramInboundPollingRuntimeOptions,
} from "./types.js";

const defaultControlConfirmationTtlMs = 60_000;

/**
 * process-local control confirmation store를 만든다.
 *
 * 재시작되면 pending 확인은 사라지며, 이 경우 control provider를 호출하지 않는 fail-closed 상태가 된다. 같은 chat/user가 같은
 * control command를 TTL 안에 다시 보낼 때만 `CONFIRMED`를 반환한다.
 */
export function createInMemoryTelegramInboundControlConfirmationStore(
  options: {
    ttlMs?: number;
    clock?: () => Date;
  } = {},
): TelegramInboundControlConfirmationStore {
  const ttlMs = options.ttlMs ?? defaultControlConfirmationTtlMs;
  const clock = options.clock ?? (() => new Date());
  const pending = new Map<string, { expiresAtMs: number; messageId: number; commandText: string }>();

  return {
    confirm(input: TelegramInboundControlConfirmationInput): TelegramInboundControlConfirmationResult {
      const now = clock();
      const nowMs = now.getTime();
      removeExpiredConfirmations(pending, nowMs);
      const key = createConfirmationKey(input);
      const existing = pending.get(key);

      if (
        existing !== undefined &&
        existing.expiresAtMs >= nowMs &&
        existing.commandText === input.command.normalizedText &&
        existing.messageId !== input.message.messageId
      ) {
        // 두 번째 동일 명령만 durable control provider로 넘기고 pending confirmation은 즉시 소모한다.
        pending.delete(key);
        return {
          status: "CONFIRMED",
          confirmedAt: now.toISOString(),
          firstMessageId: existing.messageId,
        };
      }

      const expiresAtMs = nowMs + ttlMs;
      // 첫 번째 control 명령은 상태를 바꾸지 않고 확인 대기 evidence만 memory에 남긴다.
      pending.set(key, {
        expiresAtMs,
        messageId: input.message.messageId,
        commandText: input.command.normalizedText,
      });

      return {
        status: "PENDING",
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    clear(input: TelegramInboundControlConfirmationInput): void {
      pending.delete(createConfirmationKey(input));
    },
  };
}

/**
 * Telegram inbound command runtime을 만든다.
 *
 * 이 runtime은 단일 message 처리만 담당하며 polling loop, Telegram provider 호출, DB 구현체 조립은 외부에서 주입한다.
 */
export function createTelegramInboundCommandRuntime(
  options: TelegramInboundCommandRuntimeOptions,
): TelegramInboundCommandRuntime {
  const clock = options.clock ?? (() => new Date());
  const confirmationStore =
    options.confirmationStore ??
    createInMemoryTelegramInboundControlConfirmationStore({
      clock,
    });

  return {
    async handleMessage(message: TelegramInboundCommandMessage): Promise<TelegramInboundCommandHandleResult> {
      const correlationId = createTelegramInboundCorrelationId(message);
      const parseResult = parseTelegramInboundCommand(message.text, {
        ...(options.botUsername === undefined ? {} : { botUsername: options.botUsername }),
      });
      const authorization = evaluateTelegramInboundAuthorization(message, options.allowlist);

      const dedupeResult = parseResult.status === "PARSED" && authorization.ok
        ? await recordDedupeSafely(options, message, parseResult.command, correlationId)
        : { ok: true as const };

      if (!dedupeResult.ok) {
        const audit = await appendInboundAuditEventSafely(options, {
          message,
          parseResult,
          authorization,
          correlationId,
          dedupeFailureReasonCode: "telegram_inbound_dedupe_failed",
        });
        if (!audit.ok) {
          const reply = await sendReplySafely(options, message, correlationId, formatTelegramAuditFailureResponse(correlationId));
          return createHandleResult({
            status: reply.delivered ? "AUDIT_FAILED" : "REPLY_FAILED",
            message,
            correlationId,
            executed: false,
            parseStatus: parseResult.status,
            authorization,
            reply,
            reasonCode: "telegram_inbound_audit_append_failed",
          });
        }

        // dedupe가 실패하면 같은 control 명령 재전달을 막을 수 없으므로 provider 실행 전에 멈춘다.
        const reply = await sendReplySafely(options, message, correlationId, formatTelegramDedupeFailureResponse(correlationId));
        return createHandleResult({
          status: reply.delivered ? "DEDUPE_FAILED" : "REPLY_FAILED",
          message,
          correlationId,
          executed: false,
          parseStatus: parseResult.status,
          authorization,
          auditReceipt: audit.receipt,
          reply,
          reasonCode: "telegram_inbound_dedupe_failed",
        });
      }

      const dedupe = dedupeResult.dedupe;

      const audit = await appendInboundAuditEventSafely(options, {
        message,
        parseResult,
        authorization,
        correlationId,
        ...(dedupe === undefined ? {} : { dedupe }),
      });
      if (!audit.ok) {
        const reply = authorization.ok
          ? await sendReplySafely(options, message, correlationId, formatTelegramAuditFailureResponse(correlationId))
          : undefined;

        return createHandleResult({
          status: reply !== undefined && !reply.delivered ? "REPLY_FAILED" : "AUDIT_FAILED",
          message,
          correlationId,
          executed: false,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          reply,
          reasonCode: "telegram_inbound_audit_append_failed",
        });
      }

      if (!authorization.ok) {
        // allowlist 밖 입력은 실행과 응답을 모두 생략하고 audit evidence만 남긴다.
        return createHandleResult({
          status: "UNAUTHORIZED",
          message,
          correlationId,
          executed: false,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          auditReceipt: audit.receipt,
          reasonCode: authorization.reasonCode,
        });
      }

      if (parseResult.status !== "PARSED") {
        const reply = await sendReplySafely(options, message, correlationId, parseResult.userMessage);
        return createHandleResult({
          status: reply.delivered ? parseResult.status : "REPLY_FAILED",
          message,
          correlationId,
          executed: false,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          auditReceipt: audit.receipt,
          reply,
          reasonCode: parseResult.reasonCode,
        });
      }

      if (dedupe?.duplicate) {
        // Telegram 재전달은 command provider를 다시 호출하지 않고 audit evidence만 남겨 중복 제어를 막는다.
        return createHandleResult({
          status: "DUPLICATE",
          message,
          correlationId,
          executed: false,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          auditReceipt: audit.receipt,
          reasonCode: "telegram_inbound_duplicate_command",
        });
      }

      if (parseResult.command.scope === "CONTROL") {
        const confirmationInput = {
          command: parseResult.command,
          message,
          requestedAt: clock().toISOString(),
        };
        const confirmation = confirmationStore.confirm(confirmationInput);

        if (confirmation.status === "PENDING") {
          const reply = await sendReplySafely(
            options,
            message,
            correlationId,
            formatTelegramControlConfirmationRequiredResponse({
              command: parseResult.command,
              expiresAt: confirmation.expiresAt,
              correlationId,
            }),
          );

          if (!reply.delivered) {
            // 확인 안내가 전달되지 못한 command는 두 번째 메시지만으로 실행되지 않도록 pending 상태를 제거한다.
            confirmationStore.clear(confirmationInput);
          }

          return createHandleResult({
            status: reply.delivered ? "CONFIRMATION_REQUIRED" : "REPLY_FAILED",
            message,
            correlationId,
            executed: false,
            commandName: parseResult.command.name,
            parseStatus: parseResult.status,
            authorization,
            dedupe,
            auditReceipt: audit.receipt,
            reply,
            controlConfirmation: confirmation,
          });
        }

        const controlResult = await executeControlCommandSafely(options, message, parseResult.command, correlationId);
        const reply = await sendReplySafely(options, message, correlationId, controlResult.text);
        const killSwitchResult = controlResult.ok ? controlResult.result : undefined;
        return createHandleResult({
          status: controlResult.ok ? (reply.delivered ? "EXECUTED" : "REPLY_FAILED") : "EXECUTION_FAILED",
          message,
          correlationId,
          executed: controlResult.ok,
          commandName: parseResult.command.name,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          auditReceipt: audit.receipt,
          reply,
          controlConfirmation: confirmation,
          ...(killSwitchResult === undefined ? {} : { killSwitchResult }),
          ...(controlResult.ok ? {} : { reasonCode: "telegram_inbound_command_execution_failed" }),
        });
      }

      const readOnlyResult = await executeReadOnlyCommandSafely(options, parseResult.command, correlationId);
      const reply = await sendReplySafely(options, message, correlationId, readOnlyResult.text);
      return createHandleResult({
        status: readOnlyResult.ok ? (reply.delivered ? "EXECUTED" : "REPLY_FAILED") : "EXECUTION_FAILED",
        message,
        correlationId,
        executed: readOnlyResult.ok,
        commandName: parseResult.command.name,
        parseStatus: parseResult.status,
        authorization,
        dedupe,
        auditReceipt: audit.receipt,
        reply,
        ...(readOnlyResult.ok ? {} : { reasonCode: "telegram_inbound_command_execution_failed" }),
      });
    },
  };
}

/**
 * Telegram polling provider와 command runtime을 묶은 runtime loop를 만든다.
 *
 * `start()` 호출 전에는 provider를 호출하지 않으며, `runOnce()`는 테스트/운영 probe에서 deterministic하게 한 batch만 처리한다.
 */
export function createTelegramInboundPollingRuntime(
  options: TelegramInboundPollingRuntimeOptions,
): TelegramInboundPollingRuntime {
  let offset = options.initialOffset;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight = false;

  const runOnce = async (): Promise<TelegramInboundPollingRunOnceResult> => {
    const polling = await options.pollingProvider.getUpdates({
      ...(offset === undefined ? {} : { offset }),
      timeoutSeconds: options.pollingTimeoutSeconds,
      limit: options.maxUpdatesPerPoll,
    });

    if (polling.status === "failed") {
      return {
        pollingStatus: "failed",
        pollingReasonCode: polling.reasonCode,
        updateCount: 0,
        providerNextOffset: null,
        nextOffset: offset,
        handledMessages: [],
      };
    }

    const handledMessages: TelegramInboundCommandHandleResult[] = [];
    for (const message of polling.updates) {
      handledMessages.push(await options.commandRuntime.handleMessage(message));
    }

    if (polling.nextOffset !== null) {
      // batch 처리 후에만 offset을 갱신해 처리 중 예외가 발생한 update가 조용히 skip되지 않게 한다.
      offset = polling.nextOffset;
    }

    return {
      pollingStatus: "ok",
      updateCount: polling.updates.length,
      providerNextOffset: polling.nextOffset,
      nextOffset: offset,
      handledMessages,
    };
  };

  const scheduleNext = () => {
    if (!running || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, options.pollingIntervalMs);
  };

  const tick = async () => {
    if (!running || inFlight) {
      scheduleNext();
      return;
    }

    inFlight = true;
    try {
      await runOnce();
    } catch {
      // polling provider contract 밖 예외가 loop를 영구 중단시키지 않도록 start() 경계에서만 흡수한다.
    } finally {
      inFlight = false;
      scheduleNext();
    }
  };

  return {
    runOnce,
    start() {
      if (running) {
        return;
      }
      running = true;
      void tick();
    },
    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    getCurrentOffset() {
      return offset;
    },
  };
}

function createTelegramInboundCorrelationId(message: Pick<TelegramInboundCommandMessage, "updateId" | "messageId">): string {
  return `telegram-inbound-${message.updateId}-${message.messageId}`;
}

function createConfirmationKey(input: TelegramInboundControlConfirmationInput): string {
  return [
    hashTelegramInboundIdentifier(input.message.chatId),
    input.message.userId === undefined ? "user:none" : hashTelegramInboundIdentifier(input.message.userId),
    input.command.name,
  ].join(":");
}

function removeExpiredConfirmations(
  pending: Map<string, { expiresAtMs: number; messageId: number; commandText: string }>,
  nowMs: number,
): void {
  for (const [key, value] of pending.entries()) {
    if (value.expiresAtMs < nowMs) {
      pending.delete(key);
    }
  }
}

async function appendInboundAuditEventSafely(
  options: TelegramInboundCommandRuntimeOptions,
  input: Parameters<typeof createTelegramInboundCommandAuditEvent>[0],
): Promise<
  | {
      ok: true;
      receipt: AuditEventReceipt;
    }
  | {
      ok: false;
    }
> {
  try {
    return {
      ok: true,
      receipt: await options.auditLog.appendEvent(createTelegramInboundCommandAuditEvent(input)),
    };
  } catch {
    return { ok: false };
  }
}

async function recordDedupeSafely(
  options: TelegramInboundCommandRuntimeOptions,
  message: TelegramInboundCommandMessage,
  command: ParsedTelegramInboundCommand,
  correlationId: string,
): Promise<
  | {
      ok: true;
      dedupe?: TelegramInboundCommandDedupeResult;
    }
  | {
      ok: false;
    }
> {
  try {
    return {
      ok: true,
      dedupe: await options.dedupeStore.record({
        idempotencyKey: createTelegramInboundCommandIdempotencyKey({
          message,
          command,
        }),
        occurredAt: message.receivedAt,
        metadata: {
          job_type: telegramInboundCommandJobType,
          command: command.name,
          command_scope: command.scope,
          correlation_id: correlationId,
        },
      }),
    };
  } catch {
    return { ok: false };
  }
}

async function sendReplySafely(
  options: TelegramInboundCommandRuntimeOptions,
  message: TelegramInboundCommandMessage,
  correlationId: string,
  text: string,
): Promise<TelegramInboundReplyResult> {
  try {
    return await options.replyPort.sendReply({
      chatId: message.chatId,
      text,
      correlationId,
      replyToMessageId: message.messageId,
    });
  } catch {
    return {
      delivered: false,
      skippedReason: "telegram_reply_port_exception",
    };
  }
}

async function executeReadOnlyCommandSafely(
  options: TelegramInboundCommandRuntimeOptions,
  command: ParsedTelegramInboundCommand,
  correlationId: string,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  try {
    const snapshot = await options.statusProvider.getStatus();
    switch (command.name) {
      case "status":
        return { ok: true, text: formatTelegramStatusCommandResponse(snapshot, correlationId) };
      case "positions":
        return { ok: true, text: formatTelegramPositionsCommandResponse(snapshot, correlationId) };
      case "pnl":
        return { ok: true, text: formatTelegramPnlCommandResponse(snapshot, correlationId) };
      case "why":
        return { ok: true, text: formatTelegramWhyCommandResponse(snapshot, command, correlationId) };
      case "orders":
        return { ok: true, text: formatTelegramOrdersCommandResponse(snapshot, correlationId) };
      case "risk":
        return { ok: true, text: formatTelegramRiskCommandResponse(snapshot, correlationId) };
      case "pause":
      case "resume":
      case "kill":
        return {
          ok: false,
          text: formatTelegramCommandExecutionFailureResponse({
            commandName: command.name,
            correlationId,
          }),
        };
    }
  } catch {
    return {
      ok: false,
      text: formatTelegramCommandExecutionFailureResponse({
        commandName: command.name,
        correlationId,
      }),
    };
  }
}

async function executeControlCommandSafely(
  options: TelegramInboundCommandRuntimeOptions,
  message: TelegramInboundCommandMessage,
  command: ParsedTelegramInboundCommand,
  correlationId: string,
): Promise<
  | {
      ok: true;
      text: string;
      result: Awaited<ReturnType<TelegramInboundCommandRuntimeOptions["killSwitchControlProvider"]["apply"]>>;
    }
  | {
      ok: false;
      text: string;
    }
> {
  try {
    const result = await options.killSwitchControlProvider.apply({
      targetState: mapControlCommandTargetState(command),
      reasonCode: mapControlCommandReasonCode(command),
      correlationId,
      actor: options.actor ?? "telegram-inbound",
      message: mapControlCommandMessage(command),
      metadata: createControlCommandMetadata(message, command),
    });

    return {
      ok: true,
      text: formatTelegramControlCommandResponse({
        command,
        result,
        correlationId,
      }),
      result,
    };
  } catch {
    return {
      ok: false,
      text: formatTelegramCommandExecutionFailureResponse({
        commandName: command.name,
        correlationId,
      }),
    };
  }
}

function mapControlCommandTargetState(command: ParsedTelegramInboundCommand): KillSwitchControlTargetState {
  switch (command.name) {
    case "pause":
      return "NEW_ORDERS_BLOCKED";
    case "resume":
      return "NORMAL";
    case "kill":
      return "HARD_STOP";
    default:
      throw new Error(`Unsupported control command: ${command.name}`);
  }
}

function mapControlCommandReasonCode(command: ParsedTelegramInboundCommand): string {
  switch (command.name) {
    case "pause":
      return "operator_pause";
    case "resume":
      return "operator_resume";
    case "kill":
      return "operator_kill";
    default:
      throw new Error(`Unsupported control command: ${command.name}`);
  }
}

function mapControlCommandMessage(command: ParsedTelegramInboundCommand): string {
  switch (command.name) {
    case "pause":
      return "Telegram 운영자가 신규 주문 중단을 요청했습니다.";
    case "resume":
      return "Telegram 운영자가 거래 상태 복구를 요청했습니다.";
    case "kill":
      return "Telegram 운영자가 긴급 거래 중지를 요청했습니다.";
    default:
      return "Telegram 운영자가 control 명령을 요청했습니다.";
  }
}

function createControlCommandMetadata(
  message: TelegramInboundCommandMessage,
  command: ParsedTelegramInboundCommand,
): JsonRecord {
  const metadata: JsonRecord = {
    source: "telegram_inbound_command",
    transport: "polling",
    update_id: message.updateId,
    message_id: message.messageId,
    command: command.name,
    command_scope: command.scope,
    chat_hash: hashTelegramInboundIdentifier(message.chatId),
  };

  if (message.userId !== undefined) {
    metadata.user_hash = hashTelegramInboundIdentifier(message.userId);
  }

  return metadata;
}

function createHandleResult(input: {
  status: TelegramInboundCommandHandleResult["status"];
  message: Pick<TelegramInboundCommandMessage, "updateId" | "messageId">;
  correlationId: string;
  executed: boolean;
  parseStatus: TelegramInboundCommandHandleResult["parseStatus"];
  authorization: TelegramInboundCommandHandleResult["authorization"];
  commandName?: TelegramInboundCommandHandleResult["commandName"];
  dedupe?: TelegramInboundCommandHandleResult["dedupe"];
  auditReceipt?: TelegramInboundCommandHandleResult["auditReceipt"];
  reply?: TelegramInboundCommandHandleResult["reply"];
  controlConfirmation?: TelegramInboundCommandHandleResult["controlConfirmation"];
  killSwitchResult?: TelegramInboundCommandHandleResult["killSwitchResult"];
  reasonCode?: string;
}): TelegramInboundCommandHandleResult {
  return {
    status: input.status,
    correlationId: input.correlationId,
    updateId: input.message.updateId,
    messageId: input.message.messageId,
    executed: input.executed,
    parseStatus: input.parseStatus,
    authorization: input.authorization,
    ...(input.commandName === undefined ? {} : { commandName: input.commandName }),
    ...(input.dedupe === undefined ? {} : { dedupe: input.dedupe }),
    ...(input.auditReceipt === undefined ? {} : { auditReceipt: input.auditReceipt }),
    ...(input.reply === undefined ? {} : { reply: input.reply }),
    ...(input.controlConfirmation === undefined ? {} : { controlConfirmation: input.controlConfirmation }),
    ...(input.killSwitchResult === undefined ? {} : { killSwitchResult: input.killSwitchResult }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  };
}
