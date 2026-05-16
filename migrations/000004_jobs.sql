CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED')
  ),
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts > 0),
  CHECK (attempt_count <= max_attempts)
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_after, created_at)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS jobs_locked_idx
  ON jobs (locked_at)
  WHERE locked_at IS NOT NULL;
