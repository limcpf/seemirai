CREATE TABLE IF NOT EXISTS kill_switch_state (
  scope text PRIMARY KEY CHECK (scope = 'global'),
  state text NOT NULL CHECK (
    state IN (
      'NORMAL',
      'NEW_ORDERS_BLOCKED',
      'STRATEGY_PAUSED',
      'HARD_STOP',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  reason_code text NOT NULL,
  correlation_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO kill_switch_state (scope, state, reason_code, payload_json)
VALUES ('global', 'NORMAL', 'initial_state', '{}'::jsonb)
ON CONFLICT (scope) DO NOTHING;
