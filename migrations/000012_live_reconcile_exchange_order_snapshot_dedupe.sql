-- M16 reconcile 거래소 주문 snapshot 중복 제거 contract.
-- 같은 주문의 여러 관측 시점은 append-only evidence로 보존하고, 같은 source/status/captured_at 재시도만 중복으로 접는다.

DROP INDEX IF EXISTS live_reconcile_exchange_order_snapshots_run_order_uidx;
DROP INDEX IF EXISTS live_reconcile_exchange_order_snapshots_run_identifier_uidx;
DROP INDEX IF EXISTS live_reconcile_exchange_order_snapshots_run_bridge_uidx;

-- uuid-only snapshot은 REST open/lookup이 상태 변화를 다시 관측할 수 있으므로 시각/source/status까지 같은 재시도만 중복 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_order_observation_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, exchange_order_id, source, captured_at, status)
  WHERE exchange_order_id IS NOT NULL AND identifier IS NULL;

-- identifier-only snapshot도 uuid가 나중에 관측될 수 있어 동일 관측 재시도만 중복 차단하고 상태 변화 evidence는 보존한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_identifier_observation_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, identifier, source, captured_at, status)
  WHERE exchange_order_id IS NULL AND identifier IS NOT NULL;

-- bridge snapshot은 uuid/identifier 연결 evidence이므로 같은 bridge 관측 재시도만 중복 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_bridge_observation_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, exchange_order_id, identifier, source, captured_at, status)
  WHERE exchange_order_id IS NOT NULL AND identifier IS NOT NULL;
