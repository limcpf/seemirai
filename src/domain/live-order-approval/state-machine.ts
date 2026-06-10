import type { JsonRecord, TimestampInput } from "../index.js";
import type { LiveOrderProposalStatus } from "./types.js";

const allowedLiveOrderProposalTransitions = {
  PROPOSED: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["SUBMITTED", "EXPIRED", "SUBMISSION_FAILED"],
  REJECTED: [],
  EXPIRED: [],
  SUBMITTED: [],
  SUBMISSION_FAILED: [],
} as const satisfies Record<LiveOrderProposalStatus, readonly LiveOrderProposalStatus[]>;

/**
 * M21 proposal 상태 전이 판단 입력이다.
 *
 * 호출자는 durable 상태 snapshot에서 읽은 `fromStatus`와 요청된 `toStatus`를 넘긴다. 함수는 전이를 판단만 하며,
 * audit append나 DB update 같은 side effect는 호출자가 별도 transaction에서 처리해야 한다.
 */
export interface LiveOrderProposalTransitionInput {
  proposalId: string;
  fromStatus: LiveOrderProposalStatus;
  toStatus: LiveOrderProposalStatus;
  reasonCode: string;
  occurredAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * M21 proposal 상태 전이 판단 결과다.
 *
 * `accepted=false`도 append-only evidence로 남길 수 있게 reason/message를 포함한다. 사용자 응답은 이 message를 바로 노출하지
 * 말고 한국어 상태/원인/영향/필요 조치로 재구성해야 한다.
 */
export type LiveOrderProposalTransitionDecision =
  | {
      accepted: true;
      proposalId: string;
      fromStatus: LiveOrderProposalStatus;
      toStatus: LiveOrderProposalStatus;
      reasonCode: string;
      message: string;
      occurredAt: string;
      metadata?: JsonRecord;
    }
  | {
      accepted: false;
      proposalId: string;
      fromStatus: LiveOrderProposalStatus;
      toStatus: LiveOrderProposalStatus;
      reasonCode: string;
      message: string;
      occurredAt: string;
      metadata?: JsonRecord;
    };

/**
 * M21 proposal 상태 전이를 평가한다.
 *
 * `PROPOSED`가 아닌 proposal의 재승인과 `SUBMITTED` 이후 재제출은 broker 중복 주문으로 이어질 수 있으므로 이 경계에서
 * fail-closed decision으로 돌려준다. 이 함수는 순수 state machine이며 외부 side effect가 없다.
 */
export function evaluateLiveOrderProposalTransition(
  input: LiveOrderProposalTransitionInput,
): LiveOrderProposalTransitionDecision {
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
  const common = {
    proposalId: input.proposalId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reasonCode: input.reasonCode,
    occurredAt,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };

  if (input.fromStatus === input.toStatus) {
    // 같은 상태 반복은 Telegram 재전달이나 stale worker 재시도일 수 있어 no-op 승인으로 취급하지 않는다.
    return {
      ...common,
      accepted: false,
      message: `proposal 상태가 이미 ${input.fromStatus} 이므로 중복 전이를 기록하지 않는다.`,
    };
  }

  const allowedTargets: readonly LiveOrderProposalStatus[] = allowedLiveOrderProposalTransitions[input.fromStatus];
  if (allowedTargets.includes(input.toStatus)) {
    return {
      ...common,
      accepted: true,
      message: `proposal 상태 전이 허용: ${input.fromStatus} -> ${input.toStatus}`,
    };
  }

  // 닫힌 상태나 제출 완료 상태에서의 추가 전이는 중복 주문 또는 감사 오염 위험이 있으므로 거부한다.
  return {
    ...common,
    accepted: false,
    message: `proposal 상태 전이 거부: ${input.fromStatus} -> ${input.toStatus}`,
  };
}
