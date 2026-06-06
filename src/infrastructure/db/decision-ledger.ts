/**
 * M18 판단 이유 ledger append-only persistence entry point.
 *
 * 이 파일은 public barrel 역할을 하며, 세부 구현은 `decision-ledger/` 디렉터리에 분리한다.
 */

export {
  DecisionLedgerEvidenceFrameConflictError,
  PostgresDecisionLedgerRepository,
} from "./decision-ledger/repository.js";
export {
  toDecisionLedgerFrameRowInput,
  toDecisionLedgerEvidenceRowInput,
} from "./decision-ledger/row-mapper.js";
export { DecisionLedgerPersistenceValidationError } from "./decision-ledger/validation.js";
export type {
  AppendDecisionLedgerFrameInput,
  AppendDecisionLedgerFrameResult,
  AppendDecisionLedgerEvidenceInput,
  AppendDecisionLedgerEvidenceResult,
  DecisionLedgerFrameRecord,
  DecisionLedgerEvidenceRecord,
  DecisionLedgerFrameInsertInput,
  DecisionLedgerEvidenceInsertInput,
} from "./decision-ledger/types.js";
