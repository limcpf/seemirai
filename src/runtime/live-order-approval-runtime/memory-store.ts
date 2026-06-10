import {
  createLiveOrderProposalFingerprint,
} from "../../domain/index.js";
import type {
  LiveOrderApprovalEvidenceSnapshot,
  LiveOrderProposalContract,
} from "../../domain/index.js";
import type {
  LiveOrderApprovalProposalEvidenceAppendResult,
  LiveOrderApprovalProposalStore,
  LiveOrderApprovalProposalStoreTransitionInput,
  LiveOrderApprovalProposalTransitionResult,
  RecordLiveOrderApprovalEvidenceInput,
} from "./types.js";

/**
 * 테스트와 fake integration에서 쓰는 process-local M21 proposal store를 만든다.
 *
 * 이 저장소는 production durable 중복 방지를 제공하지 않는다. 대신 Sub PR 02 runtime의 compare-and-set 상태 전이와 evidence
 * append 계약을 검증하기 위한 최소 port 구현이다.
 */
export function createInMemoryLiveOrderApprovalProposalStore(
  proposals: readonly LiveOrderProposalContract[] = [],
): LiveOrderApprovalProposalStore & {
  listEvidence(proposalId: string): readonly LiveOrderApprovalEvidenceSnapshot[];
} {
  const proposalMap = new Map<string, LiveOrderProposalContract>();
  const evidenceMap = new Map<string, LiveOrderApprovalEvidenceSnapshot[]>();
  for (const proposal of proposals) {
    proposalMap.set(proposal.proposalId, cloneProposal(proposal));
    evidenceMap.set(proposal.proposalId, []);
  }

  return {
    async findById(proposalId: string): Promise<LiveOrderProposalContract | undefined> {
      const proposal = proposalMap.get(proposalId);
      return proposal === undefined ? undefined : cloneProposal(proposal);
    },
    async recordTransition(
      input: LiveOrderApprovalProposalStoreTransitionInput,
    ): Promise<LiveOrderApprovalProposalTransitionResult> {
      const proposal = proposalMap.get(input.proposalId);
      if (proposal === undefined) {
        return { status: "NOT_FOUND" };
      }

      if (proposal.status !== input.expectedStatus) {
        // 상태 mismatch는 Telegram 재전달이나 concurrent 처리일 수 있어 기존 상태를 덮어쓰지 않는다.
        return {
          status: "STATUS_MISMATCH",
          currentStatus: proposal.status,
        };
      }

      const currentFingerprint = createLiveOrderProposalFingerprint(proposal);
      if (currentFingerprint !== input.expectedFingerprint) {
        // 같은 proposal id라도 가격/수량/예산 evidence가 달라졌으면 stale approval로 닫는다.
        return {
          status: "FINGERPRINT_MISMATCH",
          currentFingerprint,
        };
      }

      const updated = cloneProposal({
        ...proposal,
        status: input.toStatus,
      });
      proposalMap.set(input.proposalId, updated);
      appendEvidence(evidenceMap, input.proposalId, input.evidence);

      return {
        status: "RECORDED",
        proposal: cloneProposal(updated),
        evidence: input.evidence,
      };
    },
    async appendEvidence(
      input: RecordLiveOrderApprovalEvidenceInput,
    ): Promise<LiveOrderApprovalProposalEvidenceAppendResult> {
      const proposal = proposalMap.get(input.proposalId);
      if (proposal === undefined) {
        return { status: "NOT_FOUND" };
      }

      const currentFingerprint = createLiveOrderProposalFingerprint(proposal);
      if (currentFingerprint !== input.expectedFingerprint) {
        return {
          status: "FINGERPRINT_MISMATCH",
          currentFingerprint,
        };
      }

      appendEvidence(evidenceMap, input.proposalId, input.evidence);
      return {
        status: "RECORDED",
        proposal: cloneProposal(proposal),
        evidence: input.evidence,
      };
    },
    listEvidence(proposalId: string): readonly LiveOrderApprovalEvidenceSnapshot[] {
      return [...(evidenceMap.get(proposalId) ?? [])];
    },
  };
}

function appendEvidence(
  evidenceMap: Map<string, LiveOrderApprovalEvidenceSnapshot[]>,
  proposalId: string,
  evidence: LiveOrderApprovalEvidenceSnapshot,
): void {
  const values = evidenceMap.get(proposalId) ?? [];
  values.push(evidence);
  evidenceMap.set(proposalId, values);
}

function cloneProposal(proposal: LiveOrderProposalContract): LiveOrderProposalContract {
  return JSON.parse(JSON.stringify(proposal)) as LiveOrderProposalContract;
}
