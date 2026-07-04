-- Issue #258 Sub PR 01: live decision tick history.
-- live:ops/live:ops:daemon의 HOLD/BUY/SELL/BLOCK 판단을 secret-free time-series row로 저장한다.
-- HOLD는 dedupe bucket으로 저장 폭주를 줄이고, retention은 repository 경계에서 명시 cutoff로 수행한다.

CREATE TABLE IF NOT EXISTS live_decision_ticks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange text NOT NULL CHECK (btrim(exchange) <> ''),
  market text NOT NULL CHECK (btrim(market) <> ''),
  strategy_id text NOT NULL CHECK (btrim(strategy_id) <> ''),
  decision_kind text NOT NULL CHECK (decision_kind IN ('HOLD', 'BUY', 'SELL', 'BLOCK')),
  reason_code text NOT NULL CHECK (btrim(reason_code) <> ''),
  source_tick_id text NOT NULL CHECK (btrim(source_tick_id) <> ''),
  feature_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(feature_snapshot_json) = 'object'),
  threshold_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(threshold_json) = 'object'),
  order_intent_count integer NOT NULL CHECK (order_intent_count >= 0),
  dedupe_policy text NOT NULL CHECK (dedupe_policy IN ('HOLD_REASON_1M_BUCKET', 'SOURCE_TICK')),
  dedupe_bucket_started_at timestamptz NOT NULL,
  dedupe_key text NOT NULL UNIQUE CHECK (btrim(dedupe_key) <> ''),
  observed_at timestamptz NOT NULL,
  decision_at timestamptz NOT NULL,
  correlation_id text CHECK (correlation_id IS NULL OR btrim(correlation_id) <> ''),
  trace_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 최신 decision 조회와 장기 retention cutoff를 같은 time column으로 처리한다.
CREATE INDEX IF NOT EXISTS idx_live_decision_ticks_observed_at
  ON live_decision_ticks (observed_at DESC);

-- market/strategy별 최근 판단과 calibration input window 조회를 최적화한다.
CREATE INDEX IF NOT EXISTS idx_live_decision_ticks_scope
  ON live_decision_ticks (exchange, market, strategy_id, observed_at DESC);

-- HOLD bucket dedupe 동작과 저장 폭주 여부를 운영자가 확인할 수 있게 한다.
CREATE INDEX IF NOT EXISTS idx_live_decision_ticks_dedupe_bucket
  ON live_decision_ticks (dedupe_policy, dedupe_bucket_started_at DESC);
