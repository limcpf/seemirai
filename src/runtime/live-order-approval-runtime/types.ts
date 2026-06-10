import type {
  AuditLogPort,
  BrokerPort,
  ParsedTelegramInboundCommand,
} from "../../application/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  LiveOrderApprovalEvidenceSnapshot,
  LiveOrderProposalContract,
  LiveOrderProposalStatus,
  NumericString,
} from "../../domain/index.js";
import type { LiveManualApprovalRuntimeConfig } from "../live-manual-approval-config.js";

/**
 * M21 approval command runtime 입력이다.
 *
 * Telegram runtime은 parser/auth/dedupe/audit을 먼저 통과한 뒤 이 구조를 넘긴다. `occurredAt`은 approval 처리 시각이어야
 * stale backlog가 만료된 proposal을 제출하지 못하며, Telegram message 시각은 `messageReceivedAt` safe metadata로만 보존한다.
 * actor는 raw chat/user id가 아니라 hash projection이어야 하며, 이 입력 자체는 broker 호출 여부를 결정하지 않는다.
 */
export interface LiveOrderApprovalCommandRuntimeInput {
  command: ParsedTelegramInboundCommand;
  correlationId: string;
  occurredAt: string;
  messageReceivedAt?: string;
  actorHash?: string;
  dedupeKey?: string;
}

/**
 * M21 approval command 처리 상태다.
 *
 * `APPROVAL_SUBMITTED`만 broker 제출이 성공한 상태이며, 나머지는 모두 live broker 호출 전 또는 호출 실패 후의 fail-closed
 * 상태를 표현한다.
 */
export type LiveOrderApprovalCommandStatus =
  | "RUNTIME_DISABLED"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_NOT_APPROVABLE"
  | "PROPOSAL_EXPIRED"
  | "REJECTION_RECORDED"
  | "APPROVAL_RECORD_FAILED"
  | "REJECTION_RECORD_FAILED"
  | "APPROVAL_SUBMISSION_BLOCKED"
  | "APPROVAL_SUBMISSION_FAILED"
  | "APPROVAL_SUBMITTED";

/**
 * M21 approval command 처리 결과다.
 *
 * `brokerSubmitted=true`일 때만 live broker side effect가 발생했다. evidence는 runtime이 기록을 시도한 safe snapshot이며,
 * raw Telegram text나 provider body는 포함하지 않는다.
 */
export interface LiveOrderApprovalCommandRuntimeResult {
  status: LiveOrderApprovalCommandStatus;
  proposalId: string;
  brokerSubmitted: boolean;
  stateChanged: boolean;
  reasonCode: string;
  evidence: readonly LiveOrderApprovalEvidenceSnapshot[];
  brokerOrder?: BrokerOrder;
  trace?: JsonRecord;
}

/**
 * M21 approval command runtime public contract다.
 *
 * `/approve`와 `/reject` command만 처리하며, store/recheck/broker/audit side effect는 주입된 port를 통해서만 수행한다.
 */
export interface LiveOrderApprovalCommandRuntime {
  handleCommand(input: LiveOrderApprovalCommandRuntimeInput): Promise<LiveOrderApprovalCommandRuntimeResult>;
}

/**
 * M21 approval proposal store의 상태 전이 입력이다.
 *
 * expected status와 fingerprint를 함께 넘겨 Telegram 재전달, stale read, 같은 proposal id 재사용이 다른 proposal 상태를 덮어쓰지
 * 못하게 한다. 구현체는 이 비교와 evidence append를 원자적으로 수행해야 한다.
 */
export interface LiveOrderApprovalProposalStoreTransitionInput {
  proposalId: string;
  expectedStatus: LiveOrderProposalStatus;
  expectedFingerprint: string;
  toStatus: LiveOrderProposalStatus;
  evidence: LiveOrderApprovalEvidenceSnapshot;
}

/**
 * M21 approval evidence append 입력이다.
 *
 * 상태를 바꾸지 않는 recheck evidence도 fingerprint를 비교한 뒤에만 append해야, 다른 proposal snapshot의 evidence가 같은 id에
 * 섞이지 않는다.
 */
export interface RecordLiveOrderApprovalEvidenceInput {
  proposalId: string;
  expectedFingerprint: string;
  evidence: LiveOrderApprovalEvidenceSnapshot;
}

/**
 * proposal store 상태 전이 결과다.
 *
 * mismatch 결과는 broker 호출 전 fail-closed 사유로 쓰며, raw 저장소 오류는 exception으로 올려 caller가 audit/reply 실패로
 * 정규화하게 한다.
 */
export type LiveOrderApprovalProposalTransitionResult =
  | {
      status: "RECORDED";
      proposal: LiveOrderProposalContract;
      evidence: LiveOrderApprovalEvidenceSnapshot;
    }
  | {
      status: "NOT_FOUND";
    }
  | {
      status: "STATUS_MISMATCH";
      currentStatus: LiveOrderProposalStatus;
    }
  | {
      status: "FINGERPRINT_MISMATCH";
      currentFingerprint: string;
    };

/**
 * 상태 변경 없는 evidence append 결과다.
 *
 * `RECORDED`가 아니면 후속 broker side effect를 만들면 안 된다.
 */
export type LiveOrderApprovalProposalEvidenceAppendResult =
  | {
      status: "RECORDED";
      proposal: LiveOrderProposalContract;
      evidence: LiveOrderApprovalEvidenceSnapshot;
    }
  | {
      status: "NOT_FOUND";
    }
  | {
      status: "FINGERPRINT_MISMATCH";
      currentFingerprint: string;
    };

/**
 * M21 approval proposal 저장소 port다.
 *
 * production 구현은 durable storage와 unique/idempotency constraint를 사용해야 한다. memory 구현은 테스트와 local fake 용도이며,
 * 재시작 후 중복 승인 방지를 보장하지 않는다.
 */
export interface LiveOrderApprovalProposalStore {
  findById(proposalId: string): Promise<LiveOrderProposalContract | undefined>;
  recordTransition(
    input: LiveOrderApprovalProposalStoreTransitionInput,
  ): Promise<LiveOrderApprovalProposalTransitionResult>;
  appendEvidence(input: RecordLiveOrderApprovalEvidenceInput): Promise<LiveOrderApprovalProposalEvidenceAppendResult>;
}

/**
 * 제출 직전 live 상태 재검증 snapshot이다.
 *
 * approval TTL이 남아 있어도 risk, kill switch, reconcile, budget, price deviation은 이 snapshot으로 다시 확인한다. provider는 raw
 * broker/provider payload 대신 JSON-safe projection만 반환해야 한다.
 */
export interface LiveOrderApprovalSubmissionRecheckSnapshot {
  observedAt: string;
  riskApproved: boolean;
  riskDecisionId: string;
  riskApproval: JsonRecord;
  killSwitchAllowsNewOrders: boolean;
  reconcileFresh: boolean;
  dailyApprovedNotionalUsedKrw: NumericString;
  referencePrice: NumericString;
  expectedLossBpsOfEquity?: NumericString;
  metadata?: JsonRecord;
}

/**
 * M21 approval submission recheck provider 입력이다.
 *
 * provider는 proposal과 correlation id를 기준으로 최신 risk/reconcile/budget/market data projection을 읽어야 하며, broker submit은
 * 절대 수행하지 않는다.
 */
export interface LiveOrderApprovalSubmissionRecheckProvider {
  getSubmissionRecheckSnapshot(input: {
    proposal: LiveOrderProposalContract;
    correlationId: string;
    observedAt: string;
  }): Promise<LiveOrderApprovalSubmissionRecheckSnapshot>;
}

/**
 * M21 submission recheck 위반 code다.
 *
 * 사용자 응답에는 한국어 상태/원인/영향을 먼저 보여주고, 이 code는 trace/evidence metadata에만 보존한다.
 */
export type LiveOrderApprovalSubmissionRecheckViolation =
  | "m21_runtime_disabled"
  | "m21_proposal_not_approved"
  | "m21_market_not_allowed"
  | "m21_order_type_not_supported"
  | "m21_order_notional_mismatch"
  | "m21_order_notional_exceeds_limit"
  | "m21_daily_budget_exceeded"
  | "m21_risk_not_approved"
  | "m21_risk_decision_mismatch"
  | "m21_kill_switch_blocks_new_orders"
  | "m21_reconcile_not_fresh"
  | "m21_invalid_idempotency_key"
  | "m21_price_reference_invalid"
  | "m21_price_deviation_exceeded";

/**
 * M21 submission recheck 입력이다.
 *
 * 이 평가는 순수 guard이며, proposal/config/snapshot을 비교해 broker 호출 가능 여부만 결정한다.
 */
export interface LiveOrderApprovalSubmissionRecheckInput {
  proposal: LiveOrderProposalContract;
  config: LiveManualApprovalRuntimeConfig;
  snapshot: LiveOrderApprovalSubmissionRecheckSnapshot;
}

/**
 * M21 submission recheck 결과다.
 *
 * `accepted=true`인 경우에만 caller가 `BrokerPort.submitOrder`를 호출할 수 있다.
 */
export type LiveOrderApprovalSubmissionRecheckDecision =
  | {
      accepted: true;
    }
  | {
      accepted: false;
      violations: readonly LiveOrderApprovalSubmissionRecheckViolation[];
    };

/**
 * M21 approval command runtime 생성 옵션이다.
 *
 * broker는 실제 `UpbitLiveBroker` 또는 fake `BrokerPort`를 주입받는다. runtime은 config가 enabled이고 모든 recheck가 통과한
 * 승인 proposal에 대해서만 broker submit side effect를 만든다.
 */
export interface CreateLiveOrderApprovalCommandRuntimeOptions {
  config: LiveManualApprovalRuntimeConfig;
  proposalStore: LiveOrderApprovalProposalStore;
  recheckProvider: LiveOrderApprovalSubmissionRecheckProvider;
  broker: BrokerPort;
  auditLog: AuditLogPort;
  actor?: string;
  clock?: () => Date;
}
