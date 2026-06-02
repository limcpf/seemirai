-- M16 reconcile fingerprint-only snapshot idempotency.
-- uuid/identifier가 없는 snapshot도 같은 run 재시도에서는 동일 fingerprint/source/captured_at row를 중복 저장하지 않는다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_fingerprint_time_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, identity_fingerprint, source, captured_at)
  WHERE exchange_order_id IS NULL
    AND identifier IS NULL
    AND identity_fingerprint IS NOT NULL;
