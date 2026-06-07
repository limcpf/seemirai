-- M18: decision ledger append-only persistence.
-- frame 단위 판단 기록과 evidence item을 append-only로 저장한다.
-- dedupe_key와 evidence_fingerprint unique constraint로 중복 append를 차단한다.

CREATE TABLE IF NOT EXISTS decision_ledger_frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_version text NOT NULL CHECK (ledger_version = 'm18.decision_ledger.v1'),
  source_run_id text CHECK (source_run_id IS NULL OR btrim(source_run_id) <> ''),
  source_frame_id text NOT NULL CHECK (btrim(source_frame_id) <> ''),
  exchange text NOT NULL CHECK (btrim(exchange) <> ''),
  market text CHECK (market IS NULL OR btrim(market) <> ''),
  strategy_id text CHECK (strategy_id IS NULL OR btrim(strategy_id) <> ''),
  category text NOT NULL CHECK (
    category IN (
      'BUY',
      'SELL',
      'HOLD',
      'CASH_HOLD',
      'DISCARD',
      'COST_REJECTED',
      'RISK_REJECTED',
      'EXECUTION_REJECTED',
      'EXECUTED'
    )
  ),
  summary_status text NOT NULL CHECK (
    summary_status IN ('RECORDED', 'PARTIAL', 'UNAVAILABLE', 'EXPLANATION_FAILED')
  ),
  observed_at timestamptz NOT NULL,
  decision_at timestamptz NOT NULL,
  correlation_id text CHECK (correlation_id IS NULL OR btrim(correlation_id) <> ''),
  reason_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(reason_counts_json) = 'object'),
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary_json) = 'object'),
  trace_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_json) = 'object'),
  dedupe_key text NOT NULL UNIQUE CHECK (btrim(dedupe_key) <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decision_ledger_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id uuid NOT NULL REFERENCES decision_ledger_frames(id) ON DELETE CASCADE,
  evidence_kind text NOT NULL CHECK (
    evidence_kind IN (
      'STRATEGY_DECISION',
      'ORDER_INTENT',
      'DISCARD_REASON',
      'COST_BREAKDOWN',
      'RISK_DECISION',
      'EXECUTION_RESULT',
      'PNL_STATUS_CONTEXT',
      'EXPLANATION_SUMMARY',
      'EXPLANATION_FAILURE'
    )
  ),
  category text NOT NULL CHECK (
    category IN (
      'BUY',
      'SELL',
      'HOLD',
      'CASH_HOLD',
      'DISCARD',
      'COST_REJECTED',
      'RISK_REJECTED',
      'EXECUTION_REJECTED',
      'EXECUTED',
      'EXPLANATION_FAILED'
    )
  ),
  reason_code text CHECK (reason_code IS NULL OR btrim(reason_code) <> ''),
  user_message text NOT NULL CHECK (btrim(user_message) <> ''),
  impact text CHECK (impact IS NULL OR btrim(impact) <> ''),
  action text CHECK (action IS NULL OR btrim(action) <> ''),
  source text NOT NULL CHECK (btrim(source) <> ''),
  source_id text CHECK (source_id IS NULL OR btrim(source_id) <> ''),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_json) = 'object'),
  trace_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_json) = 'object'),
  evidence_fingerprint text NOT NULL UNIQUE CHECK (btrim(evidence_fingerprint) <> ''),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (evidence_kind = 'EXPLANATION_FAILURE' AND category = 'EXPLANATION_FAILED')
    OR (evidence_kind <> 'EXPLANATION_FAILURE' AND category <> 'EXPLANATION_FAILED')
  )
);

CREATE OR REPLACE FUNCTION reject_decision_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'decision ledger tables are append-only';
END;
$$;

-- ledger는 감사 근거이므로 insert 후 수정/삭제로 사후 설명이 바뀌지 못하게 DB에서도 차단한다.
CREATE TRIGGER reject_decision_ledger_frames_update
  BEFORE UPDATE ON decision_ledger_frames
  FOR EACH ROW
  EXECUTE FUNCTION reject_decision_ledger_mutation();

CREATE TRIGGER reject_decision_ledger_frames_delete
  BEFORE DELETE ON decision_ledger_frames
  FOR EACH ROW
  EXECUTE FUNCTION reject_decision_ledger_mutation();

CREATE TRIGGER reject_decision_ledger_evidence_update
  BEFORE UPDATE ON decision_ledger_evidence
  FOR EACH ROW
  EXECUTE FUNCTION reject_decision_ledger_mutation();

CREATE TRIGGER reject_decision_ledger_evidence_delete
  BEFORE DELETE ON decision_ledger_evidence
  FOR EACH ROW
  EXECUTE FUNCTION reject_decision_ledger_mutation();

-- market별 frame 조회 최적화
CREATE INDEX IF NOT EXISTS idx_decision_ledger_frames_exchange_market
  ON decision_ledger_frames (exchange, market)
  WHERE market IS NOT NULL;

-- strategy별 frame 조회 최적화
CREATE INDEX IF NOT EXISTS idx_decision_ledger_frames_strategy
  ON decision_ledger_frames (strategy_id)
  WHERE strategy_id IS NOT NULL;

-- category 필터 최적화 (CASH_HOLD 전용 조회 등)
CREATE INDEX IF NOT EXISTS idx_decision_ledger_frames_category
  ON decision_ledger_frames (category);

-- 최신 frame 조회 최적화 (/status.why timestamp 정렬)
CREATE INDEX IF NOT EXISTS idx_decision_ledger_frames_observed_at
  ON decision_ledger_frames (observed_at DESC);

-- frame 기준 evidence 조회 최적화
CREATE INDEX IF NOT EXISTS idx_decision_ledger_evidence_frame
  ON decision_ledger_evidence (frame_id);

-- evidence kind별 필터 최적화
CREATE INDEX IF NOT EXISTS idx_decision_ledger_evidence_kind
  ON decision_ledger_evidence (evidence_kind);
