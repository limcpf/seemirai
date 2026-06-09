import type { JsonRecord } from "../../domain/index.js";

/**
 * Telegram inbound 조회 명령 목록이다.
 *
 * 이 명령들은 runtime handler가 연결되더라도 주문 제출, 취소, kill switch 전이 같은 side effect를 만들면 안 된다.
 */
export const telegramInboundReadOnlyCommands = [
  "status",
  "positions",
  "pnl",
  "why",
  "orders",
  "risk",
] as const;

/**
 * Telegram inbound 제어 명령 목록이다.
 *
 * 이 명령들은 인증, 확인 절차, idempotency, audit evidence를 통과한 뒤에만 durable control provider로 전달되어야 한다.
 */
export const telegramInboundControlCommands = ["pause", "resume", "kill"] as const;

/**
 * Telegram inbound dedupe가 기존 jobs table에 남기는 전용 job type이다.
 *
 * 다른 worker가 공용 jobs table에서 이 row를 claim하지 않도록 inbound dedupe 구현은 이 type을 고정하고 idempotency key prefix를
 * 함께 사용한다.
 */
export const telegramInboundCommandJobType = "telegram.inbound.command";

/**
 * Telegram inbound가 인식하는 command name이다.
 *
 * slash prefix와 bot mention은 parser boundary에서 제거되며, 이 타입 이후의 application layer는 정규화된 lowercase 명령만 본다.
 */
export type TelegramInboundCommandName =
  | (typeof telegramInboundReadOnlyCommands)[number]
  | (typeof telegramInboundControlCommands)[number];

/**
 * Telegram command의 side effect 권한 범위다.
 *
 * `READ_ONLY`는 조회 surface만, `CONTROL`은 kill switch 계열 durable state transition 후보만 의미한다.
 */
export type TelegramInboundCommandScope = "READ_ONLY" | "CONTROL";

/**
 * Telegram command parse 결과의 고정 상태 코드다.
 *
 * 사용자에게는 한국어 안내를 먼저 보여주고, 이 code는 audit/debug trace에만 남긴다.
 */
export type TelegramInboundParseStatus = "PARSED" | "UNKNOWN" | "MALFORMED";

/**
 * `/why` 명령의 안전한 조회 대상이다.
 *
 * `cash`는 현금 보유 이유, `market`은 특정 KRW 마켓의 최근 판단 이유 조회를 뜻한다.
 */
export type TelegramInboundCommandArgument =
  | {
      kind: "cash";
    }
  | {
      kind: "market";
      market: string;
    };

/**
 * Telegram provider update에서 command 처리에 필요한 최소 메시지 projection이다.
 *
 * raw update, raw provider body, token 포함 URL은 이 경계 밖에서 버려야 한다. `text`는 parser 입력에만 사용하고 audit metadata에는
 * 저장하지 않는 것이 invariant다.
 */
export interface TelegramInboundCommandMessage {
  updateId: number;
  messageId: number;
  chatId: string;
  text: string;
  receivedAt: string;
  userId?: string;
  username?: string;
}

/**
 * 정상 parse된 Telegram command다.
 *
 * `normalizedText`는 dedupe hash 입력으로만 쓰며, audit event에는 command name과 안전한 argument projection만 남긴다.
 */
export interface ParsedTelegramInboundCommand {
  name: TelegramInboundCommandName;
  scope: TelegramInboundCommandScope;
  normalizedText: string;
  argument?: TelegramInboundCommandArgument;
}

/**
 * Telegram command parser의 union 결과다.
 *
 * 실패 결과도 한국어 사용자 안내와 안정 reason code를 함께 담아, unknown/malformed 명령이 handler 미구현 예외로 새지 않게 한다.
 */
export type TelegramInboundParseResult =
  | {
      status: "PARSED";
      command: ParsedTelegramInboundCommand;
    }
  | {
      status: "UNKNOWN" | "MALFORMED";
      reasonCode: string;
      userMessage: string;
      normalizedText: string;
    };

/**
 * Telegram inbound owner allowlist 설정이다.
 *
 * chat id allowlist가 1차 권한 경계이며, user id allowlist는 그룹 chat 같은 확장 환경에서 추가로 좁히는 선택 경계다.
 */
export interface TelegramInboundAllowlist {
  ownerChatIds: readonly string[];
  ownerUserIds?: readonly string[];
}

/**
 * Telegram inbound authorization 결과다.
 *
 * 실패 reason은 audit evidence와 사용자 응답 분기에서 쓰고, chat/user 원문은 저장하지 않고 hash projection만 남긴다.
 */
export type TelegramInboundAuthorizationResult =
  | {
      ok: true;
      reasonCode: "telegram_inbound_authorized";
    }
  | {
      ok: false;
      reasonCode:
        | "telegram_inbound_chat_not_allowed"
        | "telegram_inbound_user_not_allowed"
        | "telegram_inbound_owner_chat_allowlist_empty";
      userMessage: string;
    };

/**
 * Telegram inbound command dedupe 저장소 입력이다.
 *
 * 호출자는 parser/auth를 통과한 command의 idempotency key와 raw update를 제외한 안전 metadata만 넘겨야 한다.
 */
export interface TelegramInboundCommandDedupeInput {
  idempotencyKey: string;
  occurredAt: string;
  metadata?: JsonRecord;
}

/**
 * Telegram inbound command dedupe 저장 결과다.
 *
 * `duplicate=true`이면 runtime은 control provider나 read handler를 다시 호출하지 않고 audit evidence만 남겨야 한다.
 */
export interface TelegramInboundCommandDedupeResult {
  idempotencyKey: string;
  duplicate: boolean;
  storedAt: string;
  store: "memory" | "jobs";
  receiptId?: string;
}

/**
 * Telegram inbound command 중복 실행을 막는 application port다.
 *
 * 구현체는 같은 idempotency key를 원자적으로 한 번만 기록해야 한다. durable 구현은 기존 jobs table의 unique key를 재사용한다.
 */
export interface TelegramInboundCommandDedupeStore {
  record(input: TelegramInboundCommandDedupeInput): Promise<TelegramInboundCommandDedupeResult>;
}

/**
 * Telegram inbound audit event의 업무 결과 범주다.
 *
 * handler가 아직 연결되지 않은 Sub PR 01에서도 unauthorized, malformed, duplicate 같은 보안 경계 사건을 동일한 shape로 남긴다.
 */
export type TelegramInboundAuditOutcome =
  | "AUTHORIZED"
  | "UNAUTHORIZED"
  | "DUPLICATE"
  | "UNKNOWN"
  | "MALFORMED";
