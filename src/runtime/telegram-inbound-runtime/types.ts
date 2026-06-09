import type {
  AuditEventReceipt,
  AuditLogPort,
  KillSwitchControlProvider,
  KillSwitchControlResult,
  ParsedTelegramInboundCommand,
  TelegramInboundAllowlist,
  TelegramInboundAuthorizationResult,
  TelegramInboundCommandDedupeResult,
  TelegramInboundCommandDedupeStore,
  TelegramInboundCommandMessage,
  TelegramInboundParseStatus,
  TelegramInboundReplyPort,
  TelegramInboundReplyResult,
} from "../../application/index.js";
import type { ControlStatusProvider, ControlStatusSnapshot } from "../../interfaces/http-control/types.js";
import type { TelegramPollingProvider } from "../../infrastructure/index.js";

/**
 * Telegram inbound control 명령의 2단계 확인 저장소 입력이다.
 *
 * 확인 저장소는 같은 owner/chat/user가 같은 control 명령을 제한 시간 안에 한 번 더 보냈는지만 판단한다. DB write나
 * kill switch 전이는 이 경계에서 수행하지 않는다.
 */
export interface TelegramInboundControlConfirmationInput {
  command: ParsedTelegramInboundCommand;
  message: Pick<TelegramInboundCommandMessage, "chatId" | "messageId" | "userId">;
  requestedAt: string;
}

/**
 * Telegram inbound control 명령 확인 판정이다.
 *
 * `PENDING`은 아직 provider를 호출하지 말라는 뜻이고, `CONFIRMED`만 durable control provider로 전달할 수 있다.
 */
export type TelegramInboundControlConfirmationResult =
  | {
      status: "PENDING";
      expiresAt: string;
    }
  | {
      status: "CONFIRMED";
      confirmedAt: string;
      firstMessageId: number;
    };

/**
 * Telegram inbound control 명령의 2단계 확인 store port다.
 *
 * 기본 in-memory 구현은 재시작 시 pending 확인을 잃어버리며, 이는 control 명령을 실행하지 않는 fail-closed 동작이다.
 */
export interface TelegramInboundControlConfirmationStore {
  /** control 명령을 확인 대기 또는 확인 완료로 판정한다. */
  confirm(input: TelegramInboundControlConfirmationInput): TelegramInboundControlConfirmationResult;
  /** 확인 안내 전송 실패처럼 실행 조건이 무효화된 pending confirmation을 제거한다. */
  clear(input: TelegramInboundControlConfirmationInput): void;
}

/**
 * Telegram inbound command runtime 의존성이다.
 *
 * parser/auth/dedupe/audit은 application contract를 재사용하고, status/kill switch provider는 기존 control plane provider를
 * 주입받는다. 이 runtime은 provider를 호출하기 전 allowlist, dedupe, audit, confirmation gate를 모두 통과해야 한다.
 */
export interface TelegramInboundCommandRuntimeOptions {
  allowlist: TelegramInboundAllowlist;
  dedupeStore: TelegramInboundCommandDedupeStore;
  auditLog: AuditLogPort;
  replyPort: TelegramInboundReplyPort;
  statusProvider: ControlStatusProvider;
  killSwitchControlProvider: KillSwitchControlProvider;
  confirmationStore?: TelegramInboundControlConfirmationStore;
  botUsername?: string;
  actor?: string;
  clock?: () => Date;
}

/**
 * Telegram inbound command runtime public contract다.
 *
 * 단일 Telegram message를 처리하며, 처리 결과에는 raw text, raw chat id, token, provider body를 포함하지 않는다.
 */
export interface TelegramInboundCommandRuntime {
  handleMessage(message: TelegramInboundCommandMessage): Promise<TelegramInboundCommandHandleResult>;
}

export type TelegramInboundCommandHandleStatus =
  | "UNAUTHORIZED"
  | "UNKNOWN"
  | "MALFORMED"
  | "DUPLICATE"
  | "DEDUPE_FAILED"
  | "CONFIRMATION_REQUIRED"
  | "EXECUTED"
  | "EXECUTION_FAILED"
  | "AUDIT_FAILED"
  | "REPLY_FAILED";

/**
 * 단일 Telegram command 처리 결과다.
 *
 * `executed`는 read-only provider 조회 또는 kill switch provider 호출이 실제로 일어났는지를 나타낸다. duplicate,
 * unauthorized, malformed, confirmation pending은 모두 false여야 한다.
 */
export interface TelegramInboundCommandHandleResult {
  status: TelegramInboundCommandHandleStatus;
  correlationId: string;
  updateId: number;
  messageId: number;
  executed: boolean;
  commandName?: ParsedTelegramInboundCommand["name"];
  parseStatus: TelegramInboundParseStatus;
  authorization: TelegramInboundAuthorizationResult;
  dedupe?: TelegramInboundCommandDedupeResult;
  auditReceipt?: AuditEventReceipt;
  reply?: TelegramInboundReplyResult;
  controlConfirmation?: TelegramInboundControlConfirmationResult;
  killSwitchResult?: KillSwitchControlResult;
  reasonCode?: string;
}

/**
 * Telegram polling loop 조립 옵션이다.
 *
 * `start()`를 호출하기 전까지 polling provider는 실행되지 않는다. offset은 Telegram getUpdates의 다음 update id이며, runtime
 * 내부 memory에만 보존한다.
 */
export interface TelegramInboundPollingRuntimeOptions {
  pollingProvider: TelegramPollingProvider;
  commandRuntime: TelegramInboundCommandRuntime;
  pollingIntervalMs: number;
  pollingTimeoutSeconds: number;
  maxUpdatesPerPoll: number;
  initialOffset?: number;
}

/**
 * Telegram polling runtime의 단일 batch 처리 결과다.
 *
 * 실패 결과는 exception으로 올리지 않고 reason code와 offset 유지 여부를 caller가 판단할 수 있게 반환한다.
 */
export interface TelegramInboundPollingRunOnceResult {
  pollingStatus: "ok" | "failed";
  pollingReasonCode?: string;
  updateCount: number;
  providerNextOffset: number | null;
  nextOffset: number | undefined;
  handledMessages: readonly TelegramInboundCommandHandleResult[];
}

/**
 * Telegram inbound polling runtime public contract다.
 *
 * 장시간 loop는 `start/stop`으로 관리하고, 테스트나 CLI 검증은 `runOnce`만 호출해 외부 side effect를 명확히 제한할 수 있다.
 */
export interface TelegramInboundPollingRuntime {
  runOnce(): Promise<TelegramInboundPollingRunOnceResult>;
  start(): void;
  stop(): void;
  getCurrentOffset(): number | undefined;
}

/**
 * Telegram command formatter가 참조하는 read-only status snapshot이다.
 *
 * 기존 HTTP `/status` provider의 safe response를 그대로 재사용하므로 secret, raw provider payload, raw config는 포함되지 않는다.
 */
export type TelegramInboundControlStatusSnapshot = ControlStatusSnapshot;
