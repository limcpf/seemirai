ALTER TABLE orders
  ADD CONSTRAINT orders_status_check CHECK (
    status IN (
      'CREATED',
      'VALIDATED',
      'RISK_APPROVED',
      'RISK_REJECTED',
      'SUBMITTED',
      'ACCEPTED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCEL_REQUESTED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
      'FAILED',
      'MANUAL_REVIEW_REQUIRED'
    )
  );

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('ORDER_STATE_TRANSITION')),
  from_status text NOT NULL CHECK (
    from_status IN (
      'CREATED',
      'VALIDATED',
      'RISK_APPROVED',
      'RISK_REJECTED',
      'SUBMITTED',
      'ACCEPTED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCEL_REQUESTED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
      'FAILED',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  to_status text NOT NULL CHECK (
    to_status IN (
      'CREATED',
      'VALIDATED',
      'RISK_APPROVED',
      'RISK_REJECTED',
      'SUBMITTED',
      'ACCEPTED',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCEL_REQUESTED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
      'FAILED',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  accepted boolean NOT NULL,
  reason_code text NOT NULL,
  message text NOT NULL,
  correlation_id text,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_events_order_occurred_at_idx
  ON order_events (order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS order_events_type_occurred_at_idx
  ON order_events (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS order_events_rejected_idx
  ON order_events (order_id, occurred_at DESC)
  WHERE accepted = false;
