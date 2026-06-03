-- M16 reconcile mismatch taxonomy extension.
-- 기존 000009 migration checksum을 보존하기 위해 CHECK constraint만 후속 migration에서 교체한다.
ALTER TABLE live_reconcile_mismatch_evidence
  DROP CONSTRAINT IF EXISTS live_reconcile_mismatch_evidence_mismatch_type_check;

ALTER TABLE live_reconcile_mismatch_evidence
  ADD CONSTRAINT live_reconcile_mismatch_evidence_mismatch_type_check
  CHECK (
    mismatch_type IN (
      'UNTRACKED_EXCHANGE_OPEN_ORDER',
      'LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE',
      'PARTIAL_FILL_MISMATCH',
      'CANCEL_FAILURE_RETRY_NEEDED',
      'EXCHANGE_CANCEL_STATE_MISMATCH',
      'ORDER_STATE_ADVANCEMENT_BLOCKED',
      'BALANCE_LOCK_MISMATCH',
      'BALANCE_SNAPSHOT_UNAVAILABLE',
      'CLOSED_ORDER_WINDOW_EXCEEDED',
      'WEBSOCKET_GAP_MANUAL_REVIEW'
    )
  );
