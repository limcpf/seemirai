/**
 * M16 Reconcile Diff Engine — public entry point.
 *
 * 이 파일은 `src/application/live-reconcile/` 디렉터리의 public barrel이며,
 * 순수 reconcile diff engine의 모든 public API를 재export한다.
 *
 * 세부 구현은 같은 이름의 디렉터리 `live-reconcile/`에 분리되어 있다.
 */

export { checkBalanceLock } from "./live-reconcile/balance-policy.js";
export type { BalanceCheckResult } from "./live-reconcile/balance-policy.js";

export { runReconcileEngine } from "./live-reconcile/engine.js";

export {
  buildOrderFingerprint,
  describeExchangeOrderIdentity,
  matchOrderIdentity,
} from "./live-reconcile/identity.js";
export type {
  IdentityMatchFailure,
  IdentityMatchResult,
  IdentityMatchSuccess,
  IdentityMatchType,
} from "./live-reconcile/identity.js";

export {
  checkClosedOrderWindow,
  checkWebSocketGap,
  reconcileOrders,
} from "./live-reconcile/mismatch-policy.js";
export type { OrderPairReconcileResult } from "./live-reconcile/mismatch-policy.js";

export {
  describeFailClosedAction,
  describeReconcileSummary,
  getDefaultSeverity,
  getMismatchTypeLabel,
} from "./live-reconcile/user-facing.js";
