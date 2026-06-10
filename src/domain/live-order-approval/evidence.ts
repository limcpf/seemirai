import type { JsonRecord, TimestampInput } from "../index.js";
import { createLiveOrderProposalFingerprint } from "./fingerprint.js";
import type {
  LiveOrderApprovalEvidenceKind,
  LiveOrderApprovalEvidenceSnapshot,
  LiveOrderProposalContract,
  LiveOrderProposalStatus,
} from "./types.js";

/**
 * M21 approval evidence 생성 입력이다.
 *
 * proposal snapshot과 evidence kind는 필수이며, actor는 Telegram raw id가 아니라 hash projection만 받는다. broker order id는
 * 제출 성공 또는 실패 증거에서만 선택적으로 남긴다.
 */
export interface CreateLiveOrderApprovalEvidenceInput {
  proposal: LiveOrderProposalContract;
  evidenceKind: LiveOrderApprovalEvidenceKind;
  proposalStatus?: LiveOrderProposalStatus;
  occurredAt: TimestampInput;
  reasonCode: string;
  actorHash?: string;
  brokerOrderId?: string;
  metadata?: JsonRecord;
}

/**
 * proposal snapshot에서 append-only approval evidence를 만든다.
 *
 * evidence는 broker 호출 여부와 무관하게 같은 shape로 남기며, raw Telegram text/provider body/token/API key/JWT를 받지 않는다.
 * 이 함수는 순수 projection이고 실제 audit append 또는 DB write side effect는 호출자가 수행한다.
 */
export function createLiveOrderApprovalEvidenceSnapshot(
  input: CreateLiveOrderApprovalEvidenceInput,
): LiveOrderApprovalEvidenceSnapshot {
  const proposal = input.proposal;
  const evidence: LiveOrderApprovalEvidenceSnapshot = {
    auditKind: "LIVE_ORDER_APPROVAL",
    evidenceKind: input.evidenceKind,
    proposalId: proposal.proposalId,
    proposalStatus: input.proposalStatus ?? proposal.status,
    proposalFingerprint: createLiveOrderProposalFingerprint(proposal),
    exchangeId: proposal.exchangeId,
    market: proposal.market,
    side: proposal.side,
    orderType: proposal.orderType,
    expectedNotionalKrw: proposal.expectedNotionalKrw,
    configuredMaxOrderKrw: proposal.budget.configuredMaxOrderKrw,
    dailyApprovedNotionalLimitKrw: proposal.budget.dailyApprovedNotionalLimitKrw,
    dailyApprovedNotionalUsedKrw: proposal.budget.dailyApprovedNotionalUsedKrw,
    decisionLedgerId: proposal.decisionLedgerId,
    riskDecisionId: proposal.riskDecisionId,
    idempotencyKey: proposal.idempotencyKey,
    occurredAt: input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt,
    reasonCode: input.reasonCode,
  };

  assignIfDefined(evidence, "actorHash", input.actorHash);
  assignIfDefined(evidence, "brokerOrderId", input.brokerOrderId);
  assignIfDefined(evidence, "metadata", input.metadata);

  return evidence;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
