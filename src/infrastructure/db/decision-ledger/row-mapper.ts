import type { DecisionLedgerFrame, DecisionEvidenceItem } from "../../../application/decision-ledger.js";
import type {
  DecisionLedgerFrameInsertInput,
  DecisionLedgerEvidenceInsertInput,
} from "./types.js";
import {
  assertValidDecisionLedgerEvidenceItem,
  assertValidDecisionLedgerFrame,
} from "./validation.js";

/**
 * domain `DecisionLedgerFrame`을 `decision_ledger_frames` insert row로 변환한다.
 *
 * invariant:
 * - `reasonCounts`, `trace`는 JSON-safe object여야 한다.
 * - `summary_json`은 frame 생성 시점에 기록하는 summary metadata이며, 이후 why summary query가 채울 수 있다.
 * - `observedAt`, `decisionAt`는 Date 객체이지만 Kysely Insertable은 Date | string을 허용한다.
 *
 * @param frame domain frame
 * @returns `decision_ledger_frames` insert row
 */
export function toDecisionLedgerFrameRowInput(
  frame: DecisionLedgerFrame,
): DecisionLedgerFrameInsertInput {
  assertValidDecisionLedgerFrame(frame);

  return {
    ledger_version: frame.ledgerVersion,
    source_run_id: frame.sourceRunId,
    source_frame_id: frame.sourceFrameId,
    exchange: frame.exchange,
    market: frame.market,
    strategy_id: frame.strategyId,
    category: frame.category,
    summary_status: frame.summaryStatus,
    observed_at: frame.observedAt,
    decision_at: frame.decisionAt,
    correlation_id: frame.correlationId,
    reason_counts_json: frame.reasonCounts as Record<string, unknown>,
    summary_json: {} as Record<string, unknown>,
    trace_json: frame.trace as Record<string, unknown>,
    dedupe_key: frame.dedupeKey,
  };
}

/**
 * domain `DecisionEvidenceItem`을 `decision_ledger_evidence` insert row로 변환한다.
 *
 * invariant:
 * - `payload`와 `trace`는 JSON-safe 값만 허용한다. Date, BigInt, function 등은 포함하지 않는다.
 * - `occurredAt`는 Date 객체지만 Kysely Insertable은 Date | string을 허용한다.
 *
 * @param frameId 상위 frame의 DB id
 * @param item domain evidence item
 * @returns `decision_ledger_evidence` insert row
 */
export function toDecisionLedgerEvidenceRowInput(
  frameId: string,
  item: DecisionEvidenceItem,
): DecisionLedgerEvidenceInsertInput {
  assertValidDecisionLedgerEvidenceItem(frameId, item);

  return {
    frame_id: frameId,
    evidence_kind: item.evidenceKind,
    category: item.category,
    reason_code: item.reasonCode,
    user_message: item.userMessage,
    impact: item.impact,
    action: item.action,
    source: item.source,
    source_id: item.sourceId,
    payload_json: item.payload as Record<string, unknown>,
    trace_json: item.trace as Record<string, unknown>,
    evidence_fingerprint: item.evidenceFingerprint,
    occurred_at: item.occurredAt,
  };
}
