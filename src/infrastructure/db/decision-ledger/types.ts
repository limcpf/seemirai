import type { Insertable, Selectable } from "kysely";
import type { DecisionLedgerFrame, DecisionEvidenceItem } from "../../../application/decision-ledger.js";
import type {
  DecisionLedgerFramesTable,
  DecisionLedgerEvidenceTable,
} from "../schema.js";

/**
 * `decision_ledger_frames` 테이블에서 읽은 frame record다.
 *
 * repository가 DB write 후 또는 조회 시 반환하는 durable frame 상태이며,
 * append-only invariant에 따라 update/delete는 허용하지 않는다.
 */
export type DecisionLedgerFrameRecord = Selectable<DecisionLedgerFramesTable>;

/**
 * `decision_ledger_frames`에 insert할 입력 타입이다.
 *
 * `id`, `reason_counts_json`, `summary_json`, `trace_json`, `created_at`은 DB 기본값으로 생성된다.
 */
export type DecisionLedgerFrameInsertInput = Insertable<DecisionLedgerFramesTable>;

/**
 * `decision_ledger_evidence` 테이블에서 읽은 evidence record다.
 */
export type DecisionLedgerEvidenceRecord = Selectable<DecisionLedgerEvidenceTable>;

/**
 * `decision_ledger_evidence`에 insert할 입력 타입이다.
 *
 * `id`, `payload_json`, `trace_json`, `created_at`은 DB 기본값으로 생성된다.
 */
export type DecisionLedgerEvidenceInsertInput = Insertable<DecisionLedgerEvidenceTable>;

/**
 * repository에 frame append를 요청할 때 사용하는 입력이다.
 *
 * domain `DecisionLedgerFrame` type을 그대로 받고,
 * row mapper가 DB 호환 shape로 변환한다.
 */
export interface AppendDecisionLedgerFrameInput {
  /** append할 domain frame */
  readonly frame: DecisionLedgerFrame;
}

/**
 * frame append 결과다.
 *
 * idempotency: 같은 dedupe_key가 이미 존재하면 `inserted: false`와 기존 record를 반환한다.
 */
export interface AppendDecisionLedgerFrameResult {
  /** 이번 호출에서 새로 insert됐으면 true, 중복이면 false */
  readonly inserted: boolean;
  /** DB에 저장된 durable frame record */
  readonly record: DecisionLedgerFrameRecord;
}

/**
 * repository에 evidence batch append를 요청할 때 사용하는 입력이다.
 */
export interface AppendDecisionLedgerEvidenceInput {
  /** append할 domain evidence item */
  readonly item: DecisionEvidenceItem;
}

/**
 * evidence batch append 결과다.
 */
export interface AppendDecisionLedgerEvidenceResult {
  /** 이번 호출에서 새로 insert된 evidence 수 */
  readonly inserted: number;
  /** 이미 존재해서 skip된 evidence 수 */
  readonly skipped: number;
  /** DB에 저장된 durable evidence record 목록 */
  readonly records: readonly DecisionLedgerEvidenceRecord[];
}

/**
 * frame과 evidence batch를 같은 원자적 write로 append할 때 사용하는 입력이다.
 *
 * runner는 frame만 저장되고 evidence가 누락된 `RECORDED` 상태를 만들면 안 되므로,
 * production writer는 이 입력을 transaction 경계에서 처리한다.
 */
export interface AppendDecisionLedgerFrameWithEvidenceInput {
  /** append할 domain frame */
  readonly frame: DecisionLedgerFrame;
  /** frame 아래에 함께 append할 evidence item 목록 */
  readonly evidenceItems: readonly AppendDecisionLedgerEvidenceInput[];
}

/**
 * frame과 evidence batch를 같은 transaction에서 append한 결과다.
 */
export interface AppendDecisionLedgerFrameWithEvidenceResult {
  /** frame append 또는 idempotent reuse 결과 */
  readonly frame: AppendDecisionLedgerFrameResult;
  /** evidence batch append 결과 */
  readonly evidence: AppendDecisionLedgerEvidenceResult;
}
