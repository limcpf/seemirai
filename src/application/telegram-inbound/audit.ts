import type { AuditEvent } from "../ports/index.js";
import type { JsonRecord } from "../../domain/index.js";
import { hashTelegramInboundIdentifier } from "./security.js";
import type {
  TelegramInboundAuditOutcome,
  TelegramInboundAuthorizationResult,
  TelegramInboundCommandDedupeResult,
  TelegramInboundCommandMessage,
  TelegramInboundParseResult,
} from "./types.js";

/**
 * Telegram inbound command audit event 생성을 위한 입력이다.
 *
 * raw update와 raw message text는 이 경계에 넣지 않는다. 호출자는 parser/auth/dedupe 결과와 안전한 correlation id만 전달해야 한다.
 */
export interface CreateTelegramInboundCommandAuditEventInput {
  message: Pick<
    TelegramInboundCommandMessage,
    "updateId" | "messageId" | "chatId" | "userId" | "receivedAt"
  >;
  parseResult: TelegramInboundParseResult;
  authorization: TelegramInboundAuthorizationResult;
  occurredAt?: string;
  correlationId?: string;
  dedupe?: TelegramInboundCommandDedupeResult;
  /** dedupe 저장 경계가 실패해 provider 실행을 막은 경우, 정상 수락 audit로 오인되지 않게 남기는 안정 reason code다. */
  dedupeFailureReasonCode?: string;
}

/**
 * Telegram inbound command 처리 결과를 audit outcome으로 축약한다.
 *
 * duplicate와 unauthorized는 side effect 차단 조건이므로 parse 성공보다 우선한다. unknown/malformed는 handler dispatch 전에
 * 사용자 안내와 audit evidence로 수렴한다.
 */
export function inferTelegramInboundAuditOutcome(
  input: Pick<
    CreateTelegramInboundCommandAuditEventInput,
    "parseResult" | "authorization" | "dedupe" | "dedupeFailureReasonCode"
  >,
): TelegramInboundAuditOutcome {
  if (!input.authorization.ok) {
    return "UNAUTHORIZED";
  }

  if (input.dedupeFailureReasonCode !== undefined) {
    // dedupe 저장 실패는 실행 차단 사건이므로 authorized command로 감사되면 운영자가 장애를 놓친다.
    return "DEDUPE_FAILED";
  }

  if (input.dedupe?.duplicate) {
    return "DUPLICATE";
  }

  if (input.parseResult.status === "UNKNOWN") {
    return "UNKNOWN";
  }

  if (input.parseResult.status === "MALFORMED") {
    return "MALFORMED";
  }

  return "AUTHORIZED";
}

/**
 * Telegram inbound command audit event를 만든다.
 *
 * event payload에는 raw Telegram update, message text, token, provider body를 넣지 않는다. 운영자가 추적해야 하는 update/message
 * id와 hash 처리된 sender id, command 이름, dedupe key만 남긴다.
 */
export function createTelegramInboundCommandAuditEvent(
  input: CreateTelegramInboundCommandAuditEventInput,
): AuditEvent {
  const outcome = inferTelegramInboundAuditOutcome(input);
  const reasonCode = toAuditReasonCode(outcome, input);
  const metadata = createTelegramInboundAuditMetadata(input, outcome);

  return {
    eventType: "TELEGRAM_INBOUND_COMMAND",
    severity: toAuditSeverity(outcome),
    occurredAt: input.occurredAt ?? input.message.receivedAt,
    actor: "telegram_inbound",
    reasonCode,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    metadata,
  };
}

function createTelegramInboundAuditMetadata(
  input: CreateTelegramInboundCommandAuditEventInput,
  outcome: TelegramInboundAuditOutcome,
): JsonRecord {
  const metadata: JsonRecord = {
    audit_kind: "TELEGRAM_INBOUND_COMMAND",
    transport: "polling",
    outcome,
    update_id: input.message.updateId,
    message_id: input.message.messageId,
    chat_hash: hashTelegramInboundIdentifier(input.message.chatId),
    authorization_reason: input.authorization.reasonCode,
  };

  if (input.message.userId !== undefined) {
    metadata.user_hash = hashTelegramInboundIdentifier(input.message.userId);
  }

  if (input.parseResult.status === "PARSED") {
    metadata.command = input.parseResult.command.name;
    metadata.command_scope = input.parseResult.command.scope;
    const argument = input.parseResult.command.argument;
    if (argument?.kind === "cash") {
      metadata.command_target = "cash";
    }
    if (argument?.kind === "market") {
      metadata.command_target = argument.market;
    }
    if (argument?.kind === "proposal") {
      metadata.proposal_id = argument.proposalId;
    }
  } else {
    metadata.parse_status = input.parseResult.status;
    metadata.parse_reason = input.parseResult.reasonCode;
  }

  if (input.dedupe !== undefined) {
    metadata.dedupe_store = input.dedupe.store;
    metadata.dedupe_duplicate = input.dedupe.duplicate;
    metadata.dedupe_key = input.dedupe.idempotencyKey;
  }

  if (input.dedupeFailureReasonCode !== undefined) {
    metadata.dedupe_status = "failed";
    metadata.dedupe_failure_reason = input.dedupeFailureReasonCode;
  }

  return metadata;
}

function toAuditReasonCode(
  outcome: TelegramInboundAuditOutcome,
  input: Pick<CreateTelegramInboundCommandAuditEventInput, "parseResult" | "authorization" | "dedupeFailureReasonCode">,
): string {
  if (outcome === "UNAUTHORIZED") {
    return input.authorization.reasonCode;
  }

  if (outcome === "UNKNOWN" || outcome === "MALFORMED") {
    return input.parseResult.status === "PARSED"
      ? "telegram_command_parse_unexpected"
      : input.parseResult.reasonCode;
  }

  if (outcome === "DUPLICATE") {
    return "telegram_inbound_duplicate_command";
  }

  if (outcome === "DEDUPE_FAILED") {
    return input.dedupeFailureReasonCode ?? "telegram_inbound_dedupe_failed";
  }

  return "telegram_inbound_command_accepted";
}

function toAuditSeverity(outcome: TelegramInboundAuditOutcome): NonNullable<AuditEvent["severity"]> {
  switch (outcome) {
    case "AUTHORIZED":
    case "DUPLICATE":
      return "INFO";
    case "DEDUPE_FAILED":
      return "ERROR";
    case "UNKNOWN":
    case "MALFORMED":
    case "UNAUTHORIZED":
      return "WARN";
  }
}
