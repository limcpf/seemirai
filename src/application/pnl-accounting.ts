export {
  calculatePnLAccounting,
  PnLAccountingInvariantError,
} from "./pnl-accounting/calculator.js";
export type {
  PnLAccountingInput,
  PnLAccountingOutput,
  PnLAccountingScope,
  PnLAccountingStatus,
  PnLCashFact,
  PnLCostQualityFact,
  PnLExecutionQualityMetric,
  PnLFeeTotal,
  PnLFillFact,
  PnLMarkPriceFact,
  PnLMissingReason,
  PnLPositionDetail,
  PnLPositionFact,
  PnLReconcileFact,
  PnLSnapshotFact,
  PnLSource,
} from "./pnl-accounting/types.js";
export {
  formatMissingReason,
  formatPnLAccountingStatus,
  formatPnLSummary,
  formatScope,
  labelMissingReasonCode,
} from "./pnl-accounting/formatter.js";
export {
  buildSourceLabel,
  createSnapshotCoverage,
  resolveFillScopes,
  resolvePnLSources,
  scopeKey,
} from "./pnl-accounting/source-priority.js";
export type { SourceResolution } from "./pnl-accounting/source-priority.js";
