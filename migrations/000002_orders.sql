CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange text NOT NULL,
  market text NOT NULL,
  strategy_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type text NOT NULL CHECK (order_type IN ('LIMIT', 'MARKET')),
  status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  requested_price numeric(36, 18),
  requested_quantity numeric(36, 18) NOT NULL,
  requested_notional numeric(36, 8) NOT NULL,
  reason_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (market ~ '^KRW-[A-Z0-9]+$'),
  CHECK (requested_quantity > 0),
  CHECK (requested_notional > 0)
);

CREATE INDEX IF NOT EXISTS orders_market_status_idx ON orders (exchange, market, status);
CREATE INDEX IF NOT EXISTS orders_strategy_created_at_idx ON orders (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS paper_orders (
  order_id uuid PRIMARY KEY REFERENCES orders (id) ON DELETE CASCADE,
  post_only boolean NOT NULL DEFAULT true,
  time_in_force text CHECK (time_in_force IS NULL OR time_in_force IN ('GTC', 'IOC', 'FOK')),
  simulated_latency_ms integer CHECK (simulated_latency_ms IS NULL OR simulated_latency_ms >= 0),
  fill_model_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS fills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  exchange text NOT NULL,
  market text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price numeric(36, 18) NOT NULL,
  quantity numeric(36, 18) NOT NULL,
  fee numeric(36, 18) NOT NULL DEFAULT 0,
  fee_currency text NOT NULL DEFAULT 'KRW',
  liquidity text NOT NULL CHECK (liquidity IN ('MAKER', 'TAKER', 'SIMULATED')),
  filled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (market ~ '^KRW-[A-Z0-9]+$'),
  CHECK (price > 0),
  CHECK (quantity > 0),
  CHECK (fee >= 0)
);

CREATE INDEX IF NOT EXISTS fills_order_id_idx ON fills (order_id);
CREATE INDEX IF NOT EXISTS fills_market_filled_at_idx ON fills (exchange, market, filled_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange text NOT NULL,
  market text NOT NULL,
  strategy_id text NOT NULL,
  quantity numeric(36, 18) NOT NULL,
  average_entry_price numeric(36, 18) NOT NULL,
  realized_pnl numeric(36, 8) NOT NULL DEFAULT 0,
  unrealized_pnl numeric(36, 8) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (market ~ '^KRW-[A-Z0-9]+$'),
  UNIQUE (exchange, market, strategy_id)
);

CREATE TABLE IF NOT EXISTS policy_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange text NOT NULL,
  market text,
  source_profile text NOT NULL,
  checksum text NOT NULL,
  payload_json jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CHECK (market IS NULL OR market ~ '^KRW-[A-Z0-9]+$')
);

CREATE UNIQUE INDEX IF NOT EXISTS policy_snapshots_market_checksum_uidx
  ON policy_snapshots (exchange, market, source_profile, checksum)
  WHERE market IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS policy_snapshots_global_checksum_uidx
  ON policy_snapshots (exchange, source_profile, checksum)
  WHERE market IS NULL;

CREATE INDEX IF NOT EXISTS policy_snapshots_market_effective_at_idx
  ON policy_snapshots (exchange, market, effective_at DESC);
