CREATE TABLE IF NOT EXISTS trades (
  exchange text NOT NULL,
  market text NOT NULL,
  trade_id text NOT NULL,
  side text NOT NULL CHECK (side IN ('BUY', 'SELL', 'UNKNOWN')),
  price numeric(36, 18) NOT NULL,
  volume numeric(36, 18) NOT NULL,
  exchange_timestamp timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(market) <> ''),
  CHECK (price > 0),
  CHECK (volume > 0),
  PRIMARY KEY (exchange, market, trade_id, exchange_timestamp)
);

SELECT create_hypertable('trades', 'exchange_timestamp', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS orderbook_metrics (
  exchange text NOT NULL,
  market text NOT NULL,
  bucket_at timestamptz NOT NULL,
  best_bid_price numeric(36, 18) NOT NULL,
  best_ask_price numeric(36, 18) NOT NULL,
  spread_bps numeric(18, 6) NOT NULL,
  bid_depth_1 numeric(36, 18) NOT NULL,
  ask_depth_1 numeric(36, 18) NOT NULL,
  bid_depth_5 numeric(36, 18) NOT NULL,
  ask_depth_5 numeric(36, 18) NOT NULL,
  bid_depth_15 numeric(36, 18) NOT NULL,
  ask_depth_15 numeric(36, 18) NOT NULL,
  imbalance_5 numeric(18, 8) NOT NULL,
  imbalance_15 numeric(18, 8) NOT NULL,
  websocket_lag_ms integer,
  reconnect_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (btrim(market) <> ''),
  CHECK (best_bid_price > 0),
  CHECK (best_ask_price > 0),
  CHECK (best_ask_price >= best_bid_price),
  CHECK (spread_bps >= 0),
  CHECK (websocket_lag_ms IS NULL OR websocket_lag_ms >= 0),
  PRIMARY KEY (exchange, market, bucket_at)
);

SELECT create_hypertable('orderbook_metrics', 'bucket_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS orderbook_snapshots (
  exchange text NOT NULL,
  market text NOT NULL,
  captured_at timestamptz NOT NULL,
  bids_json jsonb NOT NULL,
  asks_json jsonb NOT NULL,
  raw_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (btrim(market) <> ''),
  PRIMARY KEY (exchange, market, captured_at)
);

SELECT create_hypertable('orderbook_snapshots', 'captured_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS candles (
  exchange text NOT NULL,
  market text NOT NULL,
  timeframe text NOT NULL CHECK (timeframe IN ('1m', '5m', '1h')),
  bucket_at timestamptz NOT NULL,
  open_price numeric(36, 18) NOT NULL,
  high_price numeric(36, 18) NOT NULL,
  low_price numeric(36, 18) NOT NULL,
  close_price numeric(36, 18) NOT NULL,
  volume numeric(36, 18) NOT NULL,
  trade_count integer NOT NULL DEFAULT 0,
  CHECK (btrim(market) <> ''),
  CHECK (open_price > 0),
  CHECK (high_price > 0),
  CHECK (low_price > 0),
  CHECK (close_price > 0),
  CHECK (high_price >= low_price),
  CHECK (high_price >= open_price),
  CHECK (high_price >= close_price),
  CHECK (low_price <= open_price),
  CHECK (low_price <= close_price),
  CHECK (volume >= 0),
  PRIMARY KEY (exchange, market, timeframe, bucket_at)
);

SELECT create_hypertable('candles', 'bucket_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  strategy_id text NOT NULL,
  market text,
  captured_at timestamptz NOT NULL,
  equity numeric(36, 8) NOT NULL,
  realized_pnl numeric(36, 8) NOT NULL,
  unrealized_pnl numeric(36, 8) NOT NULL,
  drawdown_bps numeric(18, 6) NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (drawdown_bps >= 0),
  CHECK (market IS NULL OR btrim(market) <> '')
);

CREATE INDEX IF NOT EXISTS pnl_snapshots_strategy_captured_at_idx
  ON pnl_snapshots (strategy_id, captured_at DESC);

SELECT create_hypertable('pnl_snapshots', 'captured_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS strategy_signals (
  strategy_id text NOT NULL,
  market text NOT NULL,
  signal_id uuid NOT NULL DEFAULT gen_random_uuid(),
  decision text NOT NULL CHECK (decision IN ('BUY', 'SELL', 'HOLD', 'BLOCK')),
  expected_return_bps numeric(18, 6),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL,
  CHECK (btrim(market) <> ''),
  PRIMARY KEY (strategy_id, signal_id, generated_at)
);

SELECT create_hypertable('strategy_signals', 'generated_at', if_not_exists => TRUE);
