import { Decimal } from "decimal.js";
import {
  createLiveOrderProposalFingerprint,
} from "../../domain/index.js";
import type {
  LiveOrderApprovalEvidenceSnapshot,
  LiveOrderProposalContract,
} from "../../domain/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  LiveOrderApprovalDailyBudgetReservationResult,
  LiveOrderApprovalProposalEvidenceAppendResult,
  LiveOrderApprovalProposalStore,
  LiveOrderApprovalProposalStoreTransitionInput,
  LiveOrderApprovalProposalTransitionResult,
  RecordLiveOrderApprovalEvidenceInput,
  ReserveLiveOrderApprovalDailyBudgetInput,
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
  const dailyBudgetReservationMap = new Map<string, string>();
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

      if (proposal.status !== input.expectedStatus) {
        // recheck pass evidence는 승인 상태에서만 broker 직전 증거가 될 수 있어 닫힌 상태에는 append하지 않는다.
        return {
          status: "STATUS_MISMATCH",
          currentStatus: proposal.status,
        };
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
    async reserveDailyApprovalBudget(
      input: ReserveLiveOrderApprovalDailyBudgetInput,
    ): Promise<LiveOrderApprovalDailyBudgetReservationResult> {
      const proposal = proposalMap.get(input.proposalId);
      if (proposal === undefined) {
        return { status: "NOT_FOUND" };
      }

      if (proposal.status !== input.expectedStatus) {
        // 예산 reservation은 broker 제출 직전 마지막 durable gate이므로 승인 상태가 아니면 선점하지 않는다.
        return {
          status: "STATUS_MISMATCH",
          currentStatus: proposal.status,
        };
      }

      const currentFingerprint = createLiveOrderProposalFingerprint(proposal);
      if (currentFingerprint !== input.expectedFingerprint) {
        return {
          status: "FINGERPRINT_MISMATCH",
          currentFingerprint,
        };
      }

      const requestedReservation = parseMemoryDecimal(input.reserveNotionalKrw);
      const dailyUsed = parseMemoryDecimal(input.dailyApprovedNotionalUsedKrw);
      const dailyLimit = parseMemoryDecimal(input.dailyApprovedNotionalLimitKrw);
      const alreadyReservedForProposal = parseMemoryDecimal(dailyBudgetReservationMap.get(input.proposalId) ?? "0");
      const reservedByOthers = sumReservations(dailyBudgetReservationMap).minus(alreadyReservedForProposal);
      const nextReserved = dailyUsed.plus(reservedByOthers).plus(requestedReservation);

      if (
        !requestedReservation.isFinite() ||
        requestedReservation.lte(0) ||
        !dailyUsed.isFinite() ||
        !dailyLimit.isFinite() ||
        !nextReserved.isFinite() ||
        nextReserved.gt(dailyLimit)
      ) {
        return {
          status: "DAILY_BUDGET_EXCEEDED",
          reservedNotionalKrw: nextReserved.isFinite() ? nextReserved.toFixed() : "NaN",
          dailyApprovedNotionalLimitKrw: input.dailyApprovedNotionalLimitKrw,
        };
      }

      dailyBudgetReservationMap.set(input.proposalId, requestedReservation.toFixed());
      return {
        status: "RECORDED",
        proposal: cloneProposal(proposal),
        reservedNotionalKrw: requestedReservation.toFixed(),
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

function sumReservations(reservations: Map<string, string>): Decimal {
  let total = new Decimal(0);
  for (const value of reservations.values()) {
    total = total.plus(parseMemoryDecimal(value));
  }
  return total;
}

function parseMemoryDecimal(value: string): Decimal {
  try {
    return parseFinancialDecimal(value);
  } catch {
    return new Decimal(Number.NaN);
  }
}
