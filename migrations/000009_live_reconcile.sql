-- M16 실계좌 상태 Reconcile 전용 append-only table

-- live_reconcile_runs: reconcile 실행 단위. 같은 idempotency_key 재실행은 중복 row를 만들지 않는다.
-- append-only invariant: status만 RUNNING->COMPLETED/FAILED/MANUAL_REVIEW_REQUIRED로 전이하고
-- row 자체는 삭제/덮어쓰기하지 않는다.
CREATE TABLE IF NOT EXISTS live_reconcile_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (
    status IN ('RUNNING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW_REQUIRED')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  guard_profile text,
  source_summary text,
  correlation_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(idempotency_key) <> ''),
  CHECK (guard_profile IS NULL OR btrim(guard_profile) <> ''),
  CHECK (correlation_id IS NULL OR btrim(correlation_id) <> '')
);

CREATE INDEX IF NOT EXISTS live_reconcile_runs_status_idx ON live_reconcile_runs (status);
CREATE INDEX IF NOT EXISTS live_reconcile_runs_started_at_idx ON live_reconcile_runs (started_at DESC);

-- live_reconcile_balance_snapshots: reconcile 시점의 통화별 잔고 snapshot.
-- append-only invariant: 같은 run에서 같은 currency + captured_at + source 조합은 중복 insert되지 않는다.
CREATE TABLE IF NOT EXISTS live_reconcile_balance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES live_reconcile_runs (id) ON DELETE CASCADE,
  currency text NOT NULL,
  available numeric(36, 8) NOT NULL,
  locked numeric(36, 8) NOT NULL,
  total numeric(36, 8) NOT NULL,
  captured_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('REST', 'WS')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(currency) <> ''),
  CHECK (available >= 0),
  CHECK (locked >= 0),
  CHECK (total >= 0),
  CHECK (total = available + locked)
);

-- 같은 run에서 같은 통화/시각/출처의 중복 snapshot을 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_balance_snapshots_run_currency_time_uidx
  ON live_reconcile_balance_snapshots (run_id, currency, captured_at, source);

CREATE INDEX IF NOT EXISTS live_reconcile_balance_snapshots_run_id_idx
  ON live_reconcile_balance_snapshots (run_id);

-- live_reconcile_exchange_order_snapshots: reconcile 시점의 거래소 주문 상태 snapshot.
-- append-only invariant: 같은 run에서 같은 exchange_order_id는 한 번만 저장된다.
-- identifier가 확인된 주문은 uuid 관측 전후가 달라도 identifier로 unique를 보장한다.
CREATE TABLE IF NOT EXISTS live_reconcile_exchange_order_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES live_reconcile_runs (id) ON DELETE CASCADE,
  exchange_order_id text,
  identifier text,
  market text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status text NOT NULL,
  requested_quantity numeric(36, 18) NOT NULL,
  remaining_quantity numeric(36, 18),
  requested_price numeric(36, 18),
  source text NOT NULL CHECK (source IN ('open', 'closed', 'lookup', 'ws')),
  captured_at timestamptz NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(market) <> ''),
  CHECK (exchange_order_id IS NOT NULL OR identifier IS NOT NULL),
  CHECK (exchange_order_id IS NULL OR btrim(exchange_order_id) <> ''),
  CHECK (identifier IS NULL OR btrim(identifier) <> ''),
  CHECK (requested_quantity > 0),
  CHECK (remaining_quantity IS NULL OR remaining_quantity >= 0),
  CHECK (remaining_quantity IS NULL OR remaining_quantity <= requested_quantity),
  CHECK (requested_price IS NULL OR requested_price > 0)
);

-- 같은 run에서 uuid-only snapshot 자체가 중복 저장되지 않게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_order_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, exchange_order_id)
  WHERE exchange_order_id IS NOT NULL AND identifier IS NULL;

-- 같은 run에서 identifier-only snapshot 자체가 중복 저장되지 않게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_identifier_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, identifier)
  WHERE exchange_order_id IS NULL AND identifier IS NOT NULL;

-- 두 식별자가 모두 관측된 bridge snapshot은 append-only로 보존하되 같은 bridge만 중복 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_bridge_uidx
  ON live_reconcile_exchange_order_snapshots (run_id, exchange_order_id, identifier)
  WHERE exchange_order_id IS NOT NULL AND identifier IS NOT NULL;

CREATE INDEX IF NOT EXISTS live_reconcile_exchange_order_snapshots_run_id_idx
  ON live_reconcile_exchange_order_snapshots (run_id);

-- live_reconcile_mismatch_evidence: reconcile에서 발견한 불일치 증거.
-- append-only invariant: 같은 run 안의 evidence_fingerprint 중복만 차단하고 반복 mismatch는 다음 run에 다시 기록한다.
-- message/action은 한국어 사용자 문구로 저장하고, trace_json에 안정적인 내부 코드를 분리한다.
CREATE TABLE IF NOT EXISTS live_reconcile_mismatch_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES live_reconcile_runs (id) ON DELETE CASCADE,
  mismatch_type text NOT NULL CHECK (
    mismatch_type IN (
      'UNTRACKED_EXCHANGE_OPEN_ORDER',
      'LOCAL_OPEN_ORDER_MISSING_ON_EXCHANGE',
      'PARTIAL_FILL_MISMATCH',
      'CANCEL_FAILURE_RETRY_NEEDED',
      'EXCHANGE_CANCEL_STATE_MISMATCH',
      'BALANCE_LOCK_MISMATCH',
      'BALANCE_SNAPSHOT_UNAVAILABLE',
      'CLOSED_ORDER_WINDOW_EXCEEDED',
      'WEBSOCKET_GAP_MANUAL_REVIEW'
    )
  ),
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  market text,
  order_identity text,
  currency text,
  message text NOT NULL,
  action text NOT NULL,
  evidence_fingerprint text NOT NULL,
  trace_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  CHECK (market IS NULL OR btrim(market) <> ''),
  CHECK (order_identity IS NULL OR btrim(order_identity) <> ''),
  CHECK (currency IS NULL OR btrim(currency) <> ''),
  CHECK (btrim(message) <> ''),
  CHECK (btrim(action) <> ''),
  CHECK (btrim(evidence_fingerprint) <> '')
);

CREATE INDEX IF NOT EXISTS live_reconcile_mismatch_evidence_run_id_idx
  ON live_reconcile_mismatch_evidence (run_id);

-- 같은 run 안의 재시도 중복만 차단하고, 다음 run에서 반복 관측된 mismatch는 새 evidence로 남긴다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_mismatch_evidence_run_fingerprint_uidx
  ON live_reconcile_mismatch_evidence (run_id, evidence_fingerprint);

CREATE INDEX IF NOT EXISTS live_reconcile_mismatch_evidence_type_idx
  ON live_reconcile_mismatch_evidence (mismatch_type);

CREATE INDEX IF NOT EXISTS live_reconcile_mismatch_evidence_severity_idx
  ON live_reconcile_mismatch_evidence (severity);

-- live_reconcile_position_snapshots: 복구 후보 포지션과 평균단가 산출 근거 snapshot.
-- append-only invariant: 근거 없는 positions 갱신을 막기 위해 복구 가능 여부와 evidence를 먼저 남긴다.
CREATE TABLE IF NOT EXISTS live_reconcile_position_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES live_reconcile_runs (id) ON DELETE CASCADE,
  exchange text NOT NULL,
  market text NOT NULL,
  strategy_id text NOT NULL,
  quantity numeric(36, 18) NOT NULL,
  average_entry_price numeric(36, 18),
  recovery_status text NOT NULL CHECK (recovery_status IN ('RECOVERABLE', 'MANUAL_REVIEW_REQUIRED')),
  source text NOT NULL CHECK (source IN ('fills', 'balances', 'local', 'manual_review')),
  captured_at timestamptz NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(exchange) <> ''),
  CHECK (btrim(market) <> ''),
  CHECK (btrim(strategy_id) <> ''),
  CHECK (quantity >= 0),
  CHECK (average_entry_price IS NULL OR average_entry_price >= 0),
  CHECK (average_entry_price IS NOT NULL OR recovery_status = 'MANUAL_REVIEW_REQUIRED'),
  CHECK (recovery_status = 'MANUAL_REVIEW_REQUIRED' OR quantity = 0 OR average_entry_price > 0),
  CHECK (recovery_status <> 'RECOVERABLE' OR source = 'fills')
);

-- 같은 run의 같은 포지션/source/captured_at snapshot 중복을 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_position_snapshots_identity_time_uidx
  ON live_reconcile_position_snapshots (run_id, exchange, market, strategy_id, captured_at, source);

CREATE INDEX IF NOT EXISTS live_reconcile_position_snapshots_run_id_idx
  ON live_reconcile_position_snapshots (run_id);

CREATE INDEX IF NOT EXISTS live_reconcile_position_snapshots_identity_idx
  ON live_reconcile_position_snapshots (exchange, market, strategy_id);

-- live_reconcile_fill_recovery_keys: 복구 fill insert 전에 durable unique key를 선점한다.
-- append-only invariant: 거래소 체결 id 또는 정규화 fingerprint 재관측이 같은 fills insert를 반복하지 못하게 한다.
CREATE TABLE IF NOT EXISTS live_reconcile_fill_recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES live_reconcile_runs (id) ON DELETE CASCADE,
  exchange text NOT NULL,
  market text NOT NULL,
  order_id uuid REFERENCES orders (id),
  exchange_order_id text,
  exchange_fill_id text,
  fill_fingerprint text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price numeric(36, 18) NOT NULL,
  quantity numeric(36, 18) NOT NULL,
  filled_at timestamptz NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(exchange) <> ''),
  CHECK (btrim(market) <> ''),
  CHECK (exchange_order_id IS NULL OR btrim(exchange_order_id) <> ''),
  CHECK (exchange_fill_id IS NULL OR btrim(exchange_fill_id) <> ''),
  CHECK (btrim(fill_fingerprint) <> ''),
  CHECK (price > 0),
  CHECK (quantity > 0)
);

-- 거래소 체결 id가 있는 경우 재시도/중복 reconcile에서 같은 체결 선점을 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_fill_recovery_keys_exchange_fill_uidx
  ON live_reconcile_fill_recovery_keys (exchange, exchange_fill_id)
  WHERE exchange_fill_id IS NOT NULL;

-- 거래소 체결 id가 없거나 바뀌어도 정규화 fingerprint로 같은 fill insert 반복을 차단한다.
CREATE UNIQUE INDEX IF NOT EXISTS live_reconcile_fill_recovery_keys_fingerprint_uidx
  ON live_reconcile_fill_recovery_keys (fill_fingerprint);

CREATE INDEX IF NOT EXISTS live_reconcile_fill_recovery_keys_run_id_idx
  ON live_reconcile_fill_recovery_keys (run_id);

CREATE INDEX IF NOT EXISTS live_reconcile_fill_recovery_keys_order_id_idx
  ON live_reconcile_fill_recovery_keys (order_id)
  WHERE order_id IS NOT NULL;
