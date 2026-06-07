/**
 * M18 판단 이유 ledger와 설명 API의 public entry point다.
 *
 * 이 모듈은 decision ledger frame, evidence item, why summary의 type contract와
 * 안정 category 상수만 제공한다. persistence, producer, LLM boundary, HTTP route는
 * 이 module의 하위 구현 또는 다른 layer에서 담당한다.
 *
 * ## 의존 방향
 *
 * ```
 * domain/shared -> application/decision-ledger -> interfaces/http-control
 * runtime -> application ports + infrastructure implementation 조립
 * ```
 *
 * `application`은 `infrastructure`를 import하지 않는다.
 */
export type {
  DecisionLedgerVersion,
  DecisionLedgerJsonPrimitive,
  DecisionLedgerJsonValue,
  DecisionLedgerJsonRecord,
  DecisionLedgerFrame,
  DecisionEvidenceItem,
  WhySummary,
  WhyReadStatus,
  WhySummaryTrace,
  WhyMarketSummarySection,
  WhyMarketSummary,
  WhyStrategySummarySection,
  WhyStrategySummary,
  WhyCashSummarySection,
  WhyCashSummary,
  WhyCashHoldReasonSummary,
} from "./decision-ledger/types.js";

export { DECISION_LEDGER_VERSION } from "./decision-ledger/types.js";

export {
  DecisionCategoryValue,
  DecisionFrameCategoryValue,
  SummaryStatusValue,
  EvidenceKindValue,
  isValidDecisionCategory,
  isValidDecisionFrameCategory,
  isValidEvidenceKind,
} from "./decision-ledger/category.js";

export type {
  DecisionCategory,
  DecisionFrameCategory,
  SummaryStatus,
  EvidenceKind,
} from "./decision-ledger/category.js";

export {
  buildDecisionLedgerFromRunnerResult,
  buildEvidenceItem,
  resolveFrameCategory,
} from "./decision-ledger/frame-builder.js";
export type {
  BuildEvidenceOptions,
  BuildFrameCategoryInput,
  FrameCategoryResult,
} from "./decision-ledger/frame-builder.js";
/** runner ledger write port를 application layer에서 재export한다. */
export type { PaperDecisionLedgerWriterPort } from "./paper-decision-runner/types.js";

export {
  toCategoryLabel,
  toEvidenceKindLabel,
  toWhyStatusMessages,
  toHoldReasonLabel,
} from "./decision-ledger/user-facing.js";

export {
  buildWhySummary,
} from "./decision-ledger/why-summary.js";
export type {
  WhySummaryProvider,
  WhyFrameProjection,
  WhyStrategyFrameProjection,
  WhyCashFrameProjection,
  WhyProjections,
} from "./decision-ledger/why-summary.js";
