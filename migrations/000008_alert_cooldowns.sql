CREATE TABLE IF NOT EXISTS alert_cooldowns (
  fingerprint text PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  alert_type text NOT NULL,
  market text,
  strategy_id text,
  reason_code text NOT NULL,
  last_sent_at timestamptz,
  last_skipped_at timestamptz,
  delivery_reserved_until timestamptz,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(fingerprint) <> ''),
  CHECK (btrim(alert_type) <> ''),
  CHECK (market IS NULL OR btrim(market) <> ''),
  CHECK (strategy_id IS NULL OR btrim(strategy_id) <> ''),
  CHECK (btrim(reason_code) <> '')
);

CREATE INDEX IF NOT EXISTS alert_cooldowns_severity_sent_idx
  ON alert_cooldowns (severity, last_sent_at DESC)
  WHERE last_sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS alert_cooldowns_market_sent_idx
  ON alert_cooldowns (market, last_sent_at DESC)
  WHERE market IS NOT NULL;

CREATE INDEX IF NOT EXISTS alert_cooldowns_delivery_reserved_idx
  ON alert_cooldowns (delivery_reserved_until)
  WHERE delivery_reserved_until IS NOT NULL;
