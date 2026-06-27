import {
  createLiveOpsBriefingSnapshot,
  createTelegramInboundCommandAuditEvent,
  createTelegramInboundCommandIdempotencyKey,
  evaluateTelegramInboundAuthorization,
  formatLiveOpsBriefing,
  hashTelegramInboundIdentifier,
  parseTelegramInboundCommand,
  telegramInboundCommandJobType,
} from "../../application/index.js";
import type {
  AuditEventReceipt,
  LiveOpsBriefingMarketSourceInput,
  LiveOpsBriefingPortfolioSourceInput,
  LiveOpsBriefingPositionSnapshot,
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
  formatTelegramControlConfirmationExpiredResponse,
  formatTelegramControlConfirmationRequiredResponse,
  formatTelegramDedupeFailureResponse,
  formatTelegramOrdersCommandResponse,
  formatTelegramPnlCommandResponse,
  formatTelegramPositionsCommandResponse,
  formatTelegramRiskCommandResponse,
  formatTelegramStatusCommandResponse,
  formatTelegramWhyCommandResponse,
} from "./formatter.js";
import { formatLiveOrderApprovalCommandResponse } from "../live-order-approval-runtime.js";
import type {
  TelegramInboundCommandHandleResult,
  TelegramInboundCommandRuntime,
  TelegramInboundCommandRuntimeOptions,
  CreateTelegramInboundBriefingProviderOptions,
  TelegramInboundControlStatusSnapshot,
  TelegramInboundBriefingProvider,
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
 * control command를 Telegram message 시각 기준 TTL 안에 다시 보내고, 처리 시점에도 그 메시지가 아직 fresh할 때만
 * `CONFIRMED`를 반환한다.
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
      const messageMs = readConfirmationMessageTimeMs(input.message.receivedAt, nowMs);
      const messageExpiresAtMs = messageMs + ttlMs;
      removeExpiredConfirmations(pending, nowMs);
      const key = createConfirmationKey(input);
      const existing = pending.get(key);

      if (
        existing !== undefined &&
        existing.expiresAtMs >= messageMs &&
        messageExpiresAtMs >= nowMs &&
        existing.commandText === input.command.normalizedText &&
        existing.messageId !== input.message.messageId
      ) {
        // 두 번째 동일 명령도 메시지 시각과 처리 시각 TTL을 모두 통과해야 오래된 backlog가 제어 실행으로 승격되지 않는다.
        pending.delete(key);
        return {
          status: "CONFIRMED",
          confirmedAt: new Date(messageMs).toISOString(),
          firstMessageId: existing.messageId,
        };
      }

      if (messageExpiresAtMs < nowMs) {
        pending.delete(key);
        return {
          status: "EXPIRED",
          receivedAt: new Date(messageMs).toISOString(),
          expiredAt: new Date(messageExpiresAtMs).toISOString(),
          reasonCode: "telegram_inbound_control_confirmation_expired",
        };
      }

      const expiresAtMs = messageExpiresAtMs;
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
 * `/status` safe snapshot을 기본 `/brief` provider로 감싼다.
 *
 * 이 helper는 별도 provider 조회를 새로 만들지 않고 기존 status provider가 이미 낮춘 safe snapshot만 사용한다. formatter 결과는
 * Telegram reply로 보낼 수 있는 deterministic briefing text이며, broker/control/Telegram outbound side effect를 수행하지 않는다.
 */
export function createTelegramInboundBriefingProvider(
  options: CreateTelegramInboundBriefingProviderOptions,
): TelegramInboundBriefingProvider {
  return {
    async getBriefing(input) {
      const status = await options.statusProvider.getStatus();
      const snapshot = createLiveOpsBriefingSnapshot({
        observedAt: input.occurredAt,
        status: status.liveOps ?? null,
        why: status.why,
        liveTradingEnabled: options.liveTradingEnabled ?? status.runtime.liveTradingEnabled,
        market: createBriefingMarketProjectionFromControlStatus(status),
        portfolio: createBriefingPortfolioProjectionFromControlStatus(status),
        trace: {
          evidenceIds: [input.correlationId],
          reasonCodes: ["telegram_brief_command"],
          sourceIds: ["telegram_inbound_brief_command", "http_control_status_snapshot"],
          metadata: {
            correlationId: input.correlationId,
            statusGeneratedAt: status.generatedAt,
          },
        },
      });

      return formatLiveOpsBriefing(snapshot, {
        ...(options.maxCharacters === undefined ? {} : { maxCharacters: options.maxCharacters }),
      });
    },
  };
}

/**
 * `/status.marketData` safe field를 briefing market projection으로 낮춘다.
 *
 * 기본 `/brief` provider는 별도 market provider를 호출하지 않으므로 이미 조회된 status snapshot만 사용한다. raw ticker/orderbook은
 * 없고 connection/lag/updatedAt만 전달해 formatter가 market freshness를 관측 부재로 오인하지 않게 한다.
 *
 * @param status HTTP control status safe snapshot
 * @returns briefing assembler에 전달할 market projection
 */
function createBriefingMarketProjectionFromControlStatus(
  status: TelegramInboundControlStatusSnapshot,
): LiveOpsBriefingMarketSourceInput {
  const lagText = status.marketData.lagMs === null
    ? "지연 관측 없음"
    : `지연 ${status.marketData.lagMs}ms`;
  return {
    freshnessLabel: labelBriefingMarketFreshness(status),
    summary: `시장 데이터 상태 ${status.marketData.connectionStatus}, ${lagText}.`,
    observedAt: status.marketData.updatedAt,
  };
}

/**
 * `/status`의 paper/PnL safe field를 briefing portfolio projection으로 낮춘다.
 *
 * `/status`에는 raw wallet balance나 coin별 수량이 없으므로 cash/balance는 관측 없음으로 유지한다. 대신 이미 안전하게 집계된
 * PnL과 paper position count를 넘겨 기본 `/brief`가 평가자산/PnL과 position scope를 누락하지 않게 한다.
 *
 * @param status HTTP control status safe snapshot
 * @returns briefing assembler에 전달할 portfolio projection
 */
function createBriefingPortfolioProjectionFromControlStatus(
  status: TelegramInboundControlStatusSnapshot,
): LiveOpsBriefingPortfolioSourceInput {
  return {
    cash: {
      statusLabel: "cash source 관측 없음",
      availableKrw: null,
      totalKrw: null,
      observedAt: null,
    },
    balances: null,
    positions: createBriefingPositionsFromControlStatus(status),
    pnl: {
      statusLabel: status.pnl.statusLabel,
      realizedKrw: status.pnl.latestRealizedPnlKrw,
      unrealizedKrw: status.pnl.latestUnrealizedPnlKrw,
      equityKrw: status.pnl.latestEquityKrw,
      observedAt: status.pnl.latestCapturedAt,
    },
    openExposureKrw: status.liveOps?.budget.openExposureKrw ?? null,
    budgetUsedKrw: status.liveOps?.budget.dailyNotionalUsedKrw ?? null,
  };
}

/**
 * `/status.marketData` connection/updatedAt 조합을 briefing용 freshness label로 변환한다.
 *
 * connection 문자열만으로 fresh를 만들면 오래된 상태가 정상으로 보일 수 있으므로 updatedAt이 없으면 관측 없음으로 닫는다. 이
 * 함수는 문자열 분류만 수행하며 market data provider 재조회 side effect를 만들지 않는다.
 *
 * @param status HTTP control status safe snapshot
 * @returns 운영자에게 보일 market freshness label
 */
function labelBriefingMarketFreshness(status: TelegramInboundControlStatusSnapshot): string {
  if (status.marketData.updatedAt === null) {
    // 업데이트 시각이 없으면 연결 문자열만으로 fresh 상태를 만들지 않는다.
    return "시장 데이터 관측 없음";
  }

  const normalized = status.marketData.connectionStatus.trim().toLowerCase();
  if (normalized === "connected") {
    return "시장 데이터 수신 확인";
  }
  if (normalized === "disconnected") {
    return "시장 데이터 연결 끊김";
  }
  if (normalized === "unknown") {
    return "시장 데이터 상태 확인 필요";
  }
  return `시장 데이터 ${status.marketData.connectionStatus}`;
}

/**
 * `/status.paper.openPositionCount`를 briefing position projection으로 변환한다.
 *
 * `/status`에는 개별 포지션 수량과 평균단가가 없으므로 count가 양수일 때만 대표 market에 aggregate position label을 붙인다.
 * count 결측은 무포지션이 아니라 source 결측으로 반환해 formatter가 관측 부재를 유지하게 한다.
 *
 * @param status HTTP control status safe snapshot
 * @returns briefing position projection 또는 source 결측 표시
 */
function createBriefingPositionsFromControlStatus(
  status: TelegramInboundControlStatusSnapshot,
): readonly LiveOpsBriefingPositionSnapshot[] | null {
  if (status.paper.status === "unavailable" || status.paper.openPositionCount === null) {
    // paper 집계가 실패했거나 count가 없으면 무포지션으로 보정하지 않고 position source 결측으로 둔다.
    return null;
  }
  if (status.paper.openPositionCount <= 0) {
    return [];
  }
  return [
    {
      market: status.runtime.universe.phase1[0] ?? status.runtime.market,
      quantity: null,
      averageEntryPriceKrw: null,
      statusLabel: `paper 보유 포지션 ${status.paper.openPositionCount}개`,
    },
  ];
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

        if (confirmation.status === "EXPIRED") {
          const reply = await sendReplySafely(
            options,
            message,
            correlationId,
            formatTelegramControlConfirmationExpiredResponse({
              command: parseResult.command,
              receivedAt: confirmation.receivedAt,
              expiredAt: confirmation.expiredAt,
              correlationId,
            }),
          );

          return createHandleResult({
            status: reply.delivered ? "CONFIRMATION_EXPIRED" : "REPLY_FAILED",
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
            reasonCode: confirmation.reasonCode,
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

      if (parseResult.command.scope === "APPROVAL") {
        const approvalResult = await executeLiveOrderApprovalCommandSafely(
          options,
          message,
          parseResult.command,
          correlationId,
          dedupe?.idempotencyKey,
        );
        const reply = await sendReplySafely(options, message, correlationId, approvalResult.text);
        return createHandleResult({
          status: approvalResult.ok ? (reply.delivered ? "EXECUTED" : "REPLY_FAILED") : "EXECUTION_FAILED",
          message,
          correlationId,
          executed: approvalResult.ok
            ? approvalResult.result.brokerSubmitted || approvalResult.result.stateChanged
            : false,
          commandName: parseResult.command.name,
          parseStatus: parseResult.status,
          authorization,
          dedupe,
          auditReceipt: audit.receipt,
          reply,
          ...(approvalResult.ok ? { liveOrderApprovalResult: approvalResult.result } : {}),
          ...(approvalResult.ok ? {} : { reasonCode: "telegram_inbound_approval_runtime_unavailable" }),
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

function readConfirmationMessageTimeMs(receivedAt: string, fallbackMs: number): number {
  const parsed = Date.parse(receivedAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
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
    if (command.name === "brief") {
      // 기존 runtime 조립 경계가 statusProvider만 넘겨도 `/brief` parser 활성화와 실행 가능 상태가 어긋나지 않게 기본 provider로 닫는다.
      const briefingProvider = options.briefingProvider ?? createTelegramInboundBriefingProvider({
        statusProvider: options.statusProvider,
      });
      // `/brief`는 status 조회와 같은 read-only 경로지만 별도 briefing provider만 호출해 broker/control side effect로 이어지지 않는다.
      return {
        ok: true,
        text: await briefingProvider.getBriefing({
          correlationId,
          occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
        }),
      };
    }

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
      case "approve":
      case "reject":
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

async function executeLiveOrderApprovalCommandSafely(
  options: TelegramInboundCommandRuntimeOptions,
  message: TelegramInboundCommandMessage,
  command: ParsedTelegramInboundCommand,
  correlationId: string,
  dedupeKey: string | undefined,
): Promise<
  | {
      ok: true;
      text: string;
      result: NonNullable<TelegramInboundCommandHandleResult["liveOrderApprovalResult"]>;
    }
  | {
      ok: false;
      text: string;
    }
> {
  if (options.liveOrderApprovalRuntime === undefined) {
    return {
      ok: false,
      text: formatTelegramCommandExecutionFailureResponse({
        commandName: command.name,
        correlationId,
      }),
    };
  }

  try {
    const result = await options.liveOrderApprovalRuntime.handleCommand({
      command,
      correlationId,
      // approval TTL과 recheck는 Telegram backlog 시각이 아니라 실제 처리 시각으로 평가해야 stale 승인이 제출로 승격되지 않는다.
      occurredAt: (options.clock ?? (() => new Date()))().toISOString(),
      messageReceivedAt: message.receivedAt,
      actorHash: hashTelegramInboundIdentifier(message.userId ?? message.chatId),
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
    });

    return {
      ok: true,
      text: formatLiveOrderApprovalCommandResponse(result, correlationId),
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
  liveOrderApprovalResult?: TelegramInboundCommandHandleResult["liveOrderApprovalResult"];
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
    ...(input.liveOrderApprovalResult === undefined ? {} : { liveOrderApprovalResult: input.liveOrderApprovalResult }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  };
}
