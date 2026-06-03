-- M16 reconcile identity fingerprint persistence.
-- fingerprint-only snapshot은 uuid/identifier가 없어도 감사 evidence로 저장되어야 한다.
ALTER TABLE live_reconcile_exchange_order_snapshots
  ADD COLUMN IF NOT EXISTS identity_fingerprint text;

ALTER TABLE live_reconcile_exchange_order_snapshots
  DROP CONSTRAINT IF EXISTS live_reconcile_exchange_order_snapshots_identity_present_check;

ALTER TABLE live_reconcile_exchange_order_snapshots
  DROP CONSTRAINT IF EXISTS live_reconcile_exchange_order_snapshots_identity_fingerprint_check;

DO $$
DECLARE
  old_constraint_name text;
BEGIN
  FOR old_constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'live_reconcile_exchange_order_snapshots'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%exchange_order_id IS NOT NULL%'
      AND pg_get_constraintdef(oid) LIKE '%identifier IS NOT NULL%'
      AND pg_get_constraintdef(oid) NOT LIKE '%identity_fingerprint%'
  LOOP
    EXECUTE format(
      'ALTER TABLE live_reconcile_exchange_order_snapshots DROP CONSTRAINT %I',
      old_constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE live_reconcile_exchange_order_snapshots
  ADD CONSTRAINT live_reconcile_exchange_order_snapshots_identity_present_check
  CHECK (
    exchange_order_id IS NOT NULL
    OR identifier IS NOT NULL
    OR identity_fingerprint IS NOT NULL
  );

ALTER TABLE live_reconcile_exchange_order_snapshots
  ADD CONSTRAINT live_reconcile_exchange_order_snapshots_identity_fingerprint_check
  CHECK (identity_fingerprint IS NULL OR btrim(identity_fingerprint) <> '');

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
      'ORDER_IDENTITY_CONFLICT',
      'BALANCE_LOCK_MISMATCH',
      'BALANCE_SNAPSHOT_UNAVAILABLE',
      'CLOSED_ORDER_WINDOW_EXCEEDED',
      'WEBSOCKET_GAP_MANUAL_REVIEW'
    )
  );
