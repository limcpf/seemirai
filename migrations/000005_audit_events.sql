CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL')),
  order_id uuid REFERENCES orders (id) ON DELETE SET NULL,
  correlation_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_type_occurred_at_idx
  ON audit_events (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_order_id_idx
  ON audit_events (order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS risk_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  market text,
  strategy_id text,
  order_id uuid REFERENCES orders (id) ON DELETE SET NULL,
  action text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (market IS NULL OR btrim(market) <> '')
);

CREATE INDEX IF NOT EXISTS risk_events_type_occurred_at_idx
  ON risk_events (risk_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS risk_events_market_occurred_at_idx
  ON risk_events (market, occurred_at DESC)
  WHERE market IS NOT NULL;
