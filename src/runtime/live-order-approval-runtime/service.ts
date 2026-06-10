import {
  createLiveOrderApprovalAuditEvent,
  hashTelegramInboundIdentifier,
} from "../../application/index.js";
import {
  createLiveOrderApprovalEvidenceSnapshot,
  createLiveOrderProposalFingerprint,
  evaluateLiveOrderProposalTransition,
} from "../../domain/index.js";
import type {
  BrokerOrder,
  JsonRecord,
  LiveOrderApprovalEvidenceKind,
  LiveOrderApprovalEvidenceSnapshot,
  LiveOrderProposalContract,
  OrderSubmission,
} from "../../domain/index.js";
import { evaluateLiveOrderApprovalSubmissionRecheck } from "./guard.js";
import type {
  CreateLiveOrderApprovalCommandRuntimeOptions,
  LiveOrderApprovalCommandRuntime,
  LiveOrderApprovalCommandRuntimeInput,
  LiveOrderApprovalCommandRuntimeResult,
  LiveOrderApprovalProposalTransitionResult,
  LiveOrderApprovalSubmissionRecheckSnapshot,
} from "./types.js";

/**
 * M21 Telegram approval command runtime을 만든다.
 *
 * 이 runtime은 이미 M20 parser/auth/dedupe/audit 경계를 통과한 `/approve`와 `/reject`만 처리한다. 승인 성공 경로에서도 제출
 * 직전 recheck와 proposal store evidence 기록이 끝나기 전에는 `BrokerPort.submitOrder`를 호출하지 않는다.
 */
export function createLiveOrderApprovalCommandRuntime(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
): LiveOrderApprovalCommandRuntime {
  const clock = options.clock ?? (() => new Date());

  return {
    async handleCommand(input: LiveOrderApprovalCommandRuntimeInput): Promise<LiveOrderApprovalCommandRuntimeResult> {
      const proposalId = readProposalId(input);
      const occurredAt = input.occurredAt || clock().toISOString();
      if (!options.config.enabled) {
        return createResult({
          status: "RUNTIME_DISABLED",
          proposalId,
          brokerSubmitted: false,
          stateChanged: false,
          reasonCode: "m21_manual_approval_runtime_disabled",
        });
      }

      const proposal = await options.proposalStore.findById(proposalId);
      if (proposal === undefined) {
        return createResult({
          status: "PROPOSAL_NOT_FOUND",
          proposalId,
          brokerSubmitted: false,
          stateChanged: false,
          reasonCode: "m21_proposal_not_found",
        });
      }

      if (isProposalExpired(proposal, occurredAt)) {
        return expireProposal(options, proposal, input, occurredAt);
      }

      if (proposal.status !== "PROPOSED") {
        return createResult({
          status: "PROPOSAL_NOT_APPROVABLE",
          proposalId,
          brokerSubmitted: false,
          stateChanged: false,
          reasonCode: "m21_proposal_status_not_open",
          trace: {
            proposal_status: proposal.status,
          },
        });
      }

      if (input.command.name === "reject") {
        return rejectProposal(options, proposal, input, occurredAt);
      }

      if (input.command.name === "approve") {
        return approveAndSubmitProposal(options, proposal, input, occurredAt);
      }

      return createResult({
        status: "PROPOSAL_NOT_APPROVABLE",
        proposalId,
        brokerSubmitted: false,
        stateChanged: false,
        reasonCode: "m21_unsupported_approval_command",
      });
    },
  };
}

/**
 * M21 proposal에서 broker 제출 요청을 만든다.
 *
 * OrderSubmission은 live broker side effect 직전 경계이므로 proposal id, decision ledger id, risk decision id, approval
 * fingerprint를 metadata에 보존해 후속 reconcile/audit에서 주문 출처를 추적할 수 있게 한다.
 */
export function createOrderSubmissionFromLiveOrderProposal(input: {
  proposal: LiveOrderProposalContract;
  recheck: LiveOrderApprovalSubmissionRecheckSnapshot;
  submittedAt: string;
}): OrderSubmission {
  const proposal = input.proposal;
  const fingerprint = createLiveOrderProposalFingerprint(proposal);

  return {
    intent: {
      exchangeId: proposal.exchangeId,
      market: proposal.market,
      strategyId: readStrategyId(proposal),
      side: proposal.side,
      orderType: "LIMIT",
      requestedPrice: proposal.requestedPrice,
      requestedQuantity: proposal.requestedVolume,
      requestedNotional: proposal.expectedNotionalKrw,
      idempotencyKey: proposal.idempotencyKey,
      reason: "M21 Telegram 수동 승인 주문",
      postOnly: true,
      timeInForce: "POST_ONLY",
      metadata: {
        live_order_proposal_id: proposal.proposalId,
        live_order_proposal_fingerprint: fingerprint,
        decision_ledger_id: proposal.decisionLedgerId,
        risk_decision_id: proposal.riskDecisionId,
        approval_mode: "LIVE_ARMED_MANUAL_APPROVAL",
      },
    },
    costSnapshot: proposal.costSnapshot,
    riskApproval: input.recheck.riskApproval,
    ...(input.recheck.expectedLossBpsOfEquity === undefined
      ? {}
      : { expectedLossBpsOfEquity: input.recheck.expectedLossBpsOfEquity }),
    submittedAt: input.submittedAt,
  };
}

async function rejectProposal(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  proposal: LiveOrderProposalContract,
  input: LiveOrderApprovalCommandRuntimeInput,
  occurredAt: string,
): Promise<LiveOrderApprovalCommandRuntimeResult> {
  const recorded = await recordStatusTransition(options, {
    proposal,
    input,
    occurredAt,
    toStatus: "REJECTED",
    evidenceKind: "REJECTION_RECORDED",
    reasonCode: "m21_operator_rejected",
  });

  if (recorded.status !== "RECORDED") {
    return createWriteConflictResult("REJECTION_RECORD_FAILED", proposal, recorded);
  }

  await appendApprovalAuditSafely(options, recorded.evidence, input.correlationId);
  return createResult({
    status: "REJECTION_RECORDED",
    proposalId: proposal.proposalId,
    brokerSubmitted: false,
    stateChanged: true,
    reasonCode: "m21_operator_rejected",
    evidence: [recorded.evidence],
  });
}

async function expireProposal(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  proposal: LiveOrderProposalContract,
  input: LiveOrderApprovalCommandRuntimeInput,
  occurredAt: string,
): Promise<LiveOrderApprovalCommandRuntimeResult> {
  if (proposal.status !== "PROPOSED") {
    return createResult({
      status: "PROPOSAL_NOT_APPROVABLE",
      proposalId: proposal.proposalId,
      brokerSubmitted: false,
      stateChanged: false,
      reasonCode: "m21_proposal_status_not_open",
      trace: {
        proposal_status: proposal.status,
      },
    });
  }

  const recorded = await recordStatusTransition(options, {
    proposal,
    input,
    occurredAt,
    toStatus: "EXPIRED",
    evidenceKind: "EXPIRATION_RECORDED",
    reasonCode: "m21_proposal_expired",
  });

  if (recorded.status !== "RECORDED") {
    return createWriteConflictResult("APPROVAL_RECORD_FAILED", proposal, recorded);
  }

  await appendApprovalAuditSafely(options, recorded.evidence, input.correlationId);
  return createResult({
    status: "PROPOSAL_EXPIRED",
    proposalId: proposal.proposalId,
    brokerSubmitted: false,
    stateChanged: true,
    reasonCode: "m21_proposal_expired",
    evidence: [recorded.evidence],
  });
}

async function approveAndSubmitProposal(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  proposal: LiveOrderProposalContract,
  input: LiveOrderApprovalCommandRuntimeInput,
  occurredAt: string,
): Promise<LiveOrderApprovalCommandRuntimeResult> {
  const approval = await recordStatusTransition(options, {
    proposal,
    input,
    occurredAt,
    toStatus: "APPROVED",
    evidenceKind: "APPROVAL_RECORDED",
    reasonCode: "m21_operator_approved",
  });

  if (approval.status !== "RECORDED") {
    return createWriteConflictResult("APPROVAL_RECORD_FAILED", proposal, approval);
  }

  if (!(await appendApprovalAuditSafely(options, approval.evidence, input.correlationId))) {
    return recordSubmissionFailure(options, approval.proposal, input, occurredAt, [approval.evidence], {
      reasonCode: "m21_approval_audit_append_failed",
      violations: ["m21_approval_audit_append_failed"],
    });
  }
  const approvedProposal = approval.proposal;

  let recheck: LiveOrderApprovalSubmissionRecheckSnapshot;
  try {
    recheck = await options.recheckProvider.getSubmissionRecheckSnapshot({
      proposal: approvedProposal,
      correlationId: input.correlationId,
      observedAt: occurredAt,
    });
  } catch {
    return recordSubmissionFailure(options, approvedProposal, input, occurredAt, [approval.evidence], {
      reasonCode: "m21_submission_recheck_unavailable",
      violations: ["m21_submission_recheck_unavailable"],
    });
  }

  const recheckDecision = evaluateLiveOrderApprovalSubmissionRecheck({
    proposal: approvedProposal,
    config: options.config,
    snapshot: recheck,
  });

  if (!recheckDecision.accepted) {
    return recordSubmissionFailure(options, approvedProposal, input, occurredAt, [approval.evidence], {
      reasonCode: "m21_submission_recheck_failed",
      violations: [...recheckDecision.violations],
      recheck,
    });
  }

  const recheckEvidence = createEvidence({
    proposal: approvedProposal,
    input,
    occurredAt,
    evidenceKind: "SUBMISSION_RECHECK_PASSED",
    proposalStatus: "APPROVED",
    reasonCode: "m21_submission_recheck_passed",
    metadata: {
      correlation_id: input.correlationId,
      ...(input.messageReceivedAt === undefined ? {} : { telegram_message_received_at: input.messageReceivedAt }),
      recheck_observed_at: recheck.observedAt,
      reference_price: recheck.referencePrice,
      daily_approved_notional_used_krw: recheck.dailyApprovedNotionalUsedKrw,
      risk_decision_id: recheck.riskDecisionId,
    },
  });
  const recheckAppend = await options.proposalStore.appendEvidence({
    proposalId: approvedProposal.proposalId,
    expectedFingerprint: createLiveOrderProposalFingerprint(approvedProposal),
    evidence: recheckEvidence,
  });
  if (recheckAppend.status !== "RECORDED") {
    return createResult({
      status: "APPROVAL_SUBMISSION_BLOCKED",
      proposalId: approvedProposal.proposalId,
      brokerSubmitted: false,
      stateChanged: true,
      reasonCode: "m21_submission_recheck_evidence_failed",
      evidence: [approval.evidence],
      trace: storeFailureTrace(recheckAppend),
    });
  }
  if (!(await appendApprovalAuditSafely(options, recheckEvidence, input.correlationId))) {
    return recordSubmissionFailure(options, approvedProposal, input, occurredAt, [approval.evidence, recheckEvidence], {
      reasonCode: "m21_recheck_audit_append_failed",
      violations: ["m21_recheck_audit_append_failed"],
      recheck,
    });
  }

  let brokerOrder: BrokerOrder;
  try {
    // broker submit은 approval evidence와 recheck pass evidence가 모두 저장된 뒤에만 실행한다.
    brokerOrder = await options.broker.submitOrder(
      createOrderSubmissionFromLiveOrderProposal({
        proposal: approvedProposal,
        recheck,
        submittedAt: occurredAt,
      }),
    );
  } catch {
    return recordSubmissionFailure(options, approvedProposal, input, occurredAt, [approval.evidence, recheckEvidence], {
      reasonCode: "m21_broker_submission_failed",
      recheck,
    });
  }

  const submitted = await recordStatusTransition(options, {
    proposal: approvedProposal,
    input,
    occurredAt,
    toStatus: "SUBMITTED",
    evidenceKind: "BROKER_SUBMISSION_RECORDED",
    reasonCode: "m21_broker_submission_recorded",
    brokerOrderId: brokerOrder.brokerOrderId,
    metadata: {
      correlation_id: input.correlationId,
      broker_order_status: brokerOrder.status,
      recheck_observed_at: recheck.observedAt,
    },
  });

  if (submitted.status !== "RECORDED") {
    return createResult({
      status: "APPROVAL_SUBMISSION_FAILED",
      proposalId: approvedProposal.proposalId,
      brokerSubmitted: true,
      stateChanged: true,
      reasonCode: "m21_broker_submission_evidence_failed",
      evidence: [approval.evidence, recheckEvidence],
      brokerOrder,
      trace: storeFailureTrace(submitted),
    });
  }

  if (!(await appendApprovalAuditSafely(options, submitted.evidence, input.correlationId))) {
    return createResult({
      status: "APPROVAL_SUBMISSION_FAILED",
      proposalId: approvedProposal.proposalId,
      brokerSubmitted: true,
      stateChanged: true,
      reasonCode: "m21_broker_submission_audit_append_failed",
      evidence: [approval.evidence, recheckEvidence, submitted.evidence],
      brokerOrder,
      trace: {
        audit_status: "append_failed",
      },
    });
  }
  return createResult({
    status: "APPROVAL_SUBMITTED",
    proposalId: approvedProposal.proposalId,
    brokerSubmitted: true,
    stateChanged: true,
    reasonCode: "m21_broker_submission_recorded",
    evidence: [approval.evidence, recheckEvidence, submitted.evidence],
    brokerOrder,
  });
}

async function recordSubmissionFailure(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  proposal: LiveOrderProposalContract,
  input: LiveOrderApprovalCommandRuntimeInput,
  occurredAt: string,
  priorEvidence: readonly LiveOrderApprovalEvidenceSnapshot[],
  failure: {
    reasonCode: string;
    violations?: readonly string[];
    recheck?: LiveOrderApprovalSubmissionRecheckSnapshot;
  },
): Promise<LiveOrderApprovalCommandRuntimeResult> {
  const recorded = await recordStatusTransition(options, {
    proposal,
    input,
    occurredAt,
    toStatus: "SUBMISSION_FAILED",
    evidenceKind: "SUBMISSION_FAILURE_RECORDED",
    reasonCode: failure.reasonCode,
    metadata: {
      correlation_id: input.correlationId,
      ...(failure.violations === undefined ? {} : { violations: [...failure.violations] }),
      ...(failure.recheck === undefined
        ? {}
        : {
            recheck_observed_at: failure.recheck.observedAt,
            risk_decision_id: failure.recheck.riskDecisionId,
            reference_price: failure.recheck.referencePrice,
          }),
    },
  });

  if (recorded.status !== "RECORDED") {
    return createResult({
      status: "APPROVAL_SUBMISSION_FAILED",
      proposalId: proposal.proposalId,
      brokerSubmitted: false,
      stateChanged: true,
      reasonCode: "m21_submission_failure_evidence_failed",
      evidence: priorEvidence,
      trace: storeFailureTrace(recorded),
    });
  }

  await appendApprovalAuditSafely(options, recorded.evidence, input.correlationId);
  return createResult({
    status: "APPROVAL_SUBMISSION_BLOCKED",
    proposalId: proposal.proposalId,
    brokerSubmitted: false,
    stateChanged: true,
    reasonCode: failure.reasonCode,
    evidence: [...priorEvidence, recorded.evidence],
    trace: {
      ...(failure.violations === undefined ? {} : { violations: [...failure.violations] }),
    },
  });
}

async function recordStatusTransition(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  input: {
    proposal: LiveOrderProposalContract;
    input: LiveOrderApprovalCommandRuntimeInput;
    occurredAt: string;
    toStatus: LiveOrderProposalContract["status"];
    evidenceKind: LiveOrderApprovalEvidenceKind;
    reasonCode: string;
    brokerOrderId?: string;
    metadata?: JsonRecord;
  },
): Promise<LiveOrderApprovalProposalTransitionResult> {
  const transition = evaluateLiveOrderProposalTransition({
    proposalId: input.proposal.proposalId,
    fromStatus: input.proposal.status,
    toStatus: input.toStatus,
    reasonCode: input.reasonCode,
    occurredAt: input.occurredAt,
  });
  if (!transition.accepted) {
    return {
      status: "STATUS_MISMATCH",
      currentStatus: input.proposal.status,
    };
  }

  const evidence = createEvidence({
    proposal: input.proposal,
    input: input.input,
    occurredAt: input.occurredAt,
    evidenceKind: input.evidenceKind,
    proposalStatus: input.toStatus,
    reasonCode: input.reasonCode,
    ...(input.brokerOrderId === undefined ? {} : { brokerOrderId: input.brokerOrderId }),
    metadata: {
      correlation_id: input.input.correlationId,
      ...(input.input.dedupeKey === undefined ? {} : { dedupe_key: input.input.dedupeKey }),
      ...(input.input.messageReceivedAt === undefined
        ? {}
        : { telegram_message_received_at: input.input.messageReceivedAt }),
      ...(input.metadata ?? {}),
    },
  });

  return options.proposalStore.recordTransition({
    proposalId: input.proposal.proposalId,
    expectedStatus: input.proposal.status,
    expectedFingerprint: createLiveOrderProposalFingerprint(input.proposal),
    toStatus: input.toStatus,
    evidence,
  });
}

function createEvidence(input: {
  proposal: LiveOrderProposalContract;
  input: LiveOrderApprovalCommandRuntimeInput;
  occurredAt: string;
  evidenceKind: LiveOrderApprovalEvidenceKind;
  proposalStatus: LiveOrderProposalContract["status"];
  reasonCode: string;
  brokerOrderId?: string;
  metadata?: JsonRecord;
}): LiveOrderApprovalEvidenceSnapshot {
  return createLiveOrderApprovalEvidenceSnapshot({
    proposal: input.proposal,
    evidenceKind: input.evidenceKind,
    proposalStatus: input.proposalStatus,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
    ...(input.input.actorHash === undefined ? {} : { actorHash: input.input.actorHash }),
    ...(input.brokerOrderId === undefined ? {} : { brokerOrderId: input.brokerOrderId }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  });
}

async function appendApprovalAuditSafely(
  options: CreateLiveOrderApprovalCommandRuntimeOptions,
  evidence: LiveOrderApprovalEvidenceSnapshot,
  correlationId: string,
): Promise<boolean> {
  try {
    // broker 제출 전 approval/recheck audit projection이 빠지면 운영 증거가 불완전하므로 caller가 제출을 차단할 수 있게 결과를 돌려준다.
    await options.auditLog.appendEvent(
      createLiveOrderApprovalAuditEvent({
        evidence,
        actor: options.actor ?? "live_manual_approval",
        correlationId,
      }),
    );
    return true;
  } catch {
    // adapter 원문 오류는 Telegram 응답에 노출하지 않고 reason/evidence 경로에서 fail-closed로 정규화한다.
    return false;
  }
}

function createWriteConflictResult(
  status: "APPROVAL_RECORD_FAILED" | "REJECTION_RECORD_FAILED",
  proposal: LiveOrderProposalContract,
  recorded: Exclude<LiveOrderApprovalProposalTransitionResult, { status: "RECORDED" }>,
): LiveOrderApprovalCommandRuntimeResult {
  return createResult({
    status,
    proposalId: proposal.proposalId,
    brokerSubmitted: false,
    stateChanged: false,
    reasonCode: "m21_proposal_write_conflict",
    trace: storeFailureTrace(recorded),
  });
}

function createResult(input: {
  status: LiveOrderApprovalCommandRuntimeResult["status"];
  proposalId: string;
  brokerSubmitted: boolean;
  stateChanged: boolean;
  reasonCode: string;
  evidence?: readonly LiveOrderApprovalEvidenceSnapshot[];
  brokerOrder?: BrokerOrder;
  trace?: JsonRecord;
}): LiveOrderApprovalCommandRuntimeResult {
  return {
    status: input.status,
    proposalId: input.proposalId,
    brokerSubmitted: input.brokerSubmitted,
    stateChanged: input.stateChanged,
    reasonCode: input.reasonCode,
    evidence: input.evidence ?? [],
    ...(input.brokerOrder === undefined ? {} : { brokerOrder: input.brokerOrder }),
    ...(input.trace === undefined ? {} : { trace: input.trace }),
  };
}

function readProposalId(input: LiveOrderApprovalCommandRuntimeInput): string {
  const argument = input.command.argument;
  return argument?.kind === "proposal" ? argument.proposalId : "unknown-proposal";
}

function isProposalExpired(proposal: LiveOrderProposalContract, observedAt: string): boolean {
  return readTimeMs(proposal.expiresAt) <= readTimeMs(observedAt);
}

function readTimeMs(value: LiveOrderProposalContract["expiresAt"]): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function readStrategyId(proposal: LiveOrderProposalContract): string {
  const strategyId = proposal.metadata?.strategy_id;
  return typeof strategyId === "string" && strategyId.trim().length > 0
    ? strategyId
    : "m21_manual_approval";
}

function storeFailureTrace(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || !("status" in value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    store_status: record.status,
    ...(record.currentStatus === undefined ? {} : { current_status: record.currentStatus }),
    ...(record.currentFingerprint === undefined ? {} : { current_fingerprint: record.currentFingerprint }),
  };
}

/**
 * Telegram raw id를 M21 evidence actor hash로 낮춘다.
 *
 * caller가 이미 hash를 계산한 경우에는 그 값을 우선하고, user id가 없으면 chat id hash를 사용한다. 이 함수는 raw id를 저장하지
 * 않는 projection만 수행한다.
 */
export function createLiveOrderApprovalActorHash(input: {
  actorHash?: string;
  userId?: string;
  chatId: string;
}): string {
  return input.actorHash ?? hashTelegramInboundIdentifier(input.userId ?? input.chatId);
}
