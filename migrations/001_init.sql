-- Prediction Predator schema v1
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS signals (
  id BIGSERIAL PRIMARY KEY,
  market_ticker TEXT NOT NULL,
  event_ticker TEXT,
  question TEXT NOT NULL,
  category TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('YES', 'NO')),
  market_yes_price_cents INT NOT NULL,
  market_no_price_cents INT NOT NULL,
  spread_cents INT NOT NULL,
  model_p_yes NUMERIC(5,4) NOT NULL,
  confidence NUMERIC(5,4) NOT NULL,
  edge_cents INT NOT NULL,
  recommended_size_usd NUMERIC(10,2) NOT NULL,
  rationale TEXT NOT NULL,
  forecast_model TEXT NOT NULL,
  classifier_model TEXT NOT NULL,
  news_sources_used TEXT[] DEFAULT '{}',
  resolves_at TIMESTAMPTZ,
  trading_mode TEXT NOT NULL,
  order_action TEXT NOT NULL,
  order_external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_outcome TEXT,
  resolved_at TIMESTAMPTZ,
  was_correct BOOLEAN,
  pnl_usd NUMERIC(10,2),
  signal_version TEXT NOT NULL DEFAULT 'v1'
);

CREATE UNIQUE INDEX IF NOT EXISTS signals_idempotency
  ON signals (market_ticker, signal_version, ((created_at AT TIME ZONE 'UTC')::date));

CREATE INDEX IF NOT EXISTS signals_unresolved
  ON signals (resolved_at) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS signals_category_created
  ON signals (category, created_at DESC);

CREATE TABLE IF NOT EXISTS market_classifications (
  market_ticker TEXT PRIMARY KEY,
  in_scope BOOLEAN NOT NULL,
  category TEXT,
  reason TEXT,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  classifier_model TEXT NOT NULL,
  resolves_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS market_classifications_in_scope
  ON market_classifications (in_scope, resolves_at);

CREATE TABLE IF NOT EXISTS news_cache (
  id BIGSERIAL PRIMARY KEY,
  query_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  query TEXT NOT NULL,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS news_cache_query_hash
  ON news_cache (query_hash, fetched_at DESC);

CREATE TABLE IF NOT EXISTS calibration_buckets (
  bucket_lower NUMERIC(3,2) NOT NULL,
  bucket_upper NUMERIC(3,2) NOT NULL,
  category TEXT NOT NULL,
  signal_count INT NOT NULL DEFAULT 0,
  yes_resolved_count INT NOT NULL DEFAULT 0,
  observed_freq NUMERIC(5,4),
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_lower, bucket_upper, category)
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id BIGSERIAL PRIMARY KEY,
  signal_id BIGINT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  market_ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  size_contracts INT NOT NULL,
  entry_price_cents INT NOT NULL,
  cost_usd NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  exit_outcome TEXT,
  pnl_usd NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS paper_positions_open
  ON paper_positions (status) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  markets_scanned INT DEFAULT 0,
  markets_classified_in_scope INT DEFAULT 0,
  signals_fired INT DEFAULT 0,
  errors_count INT DEFAULT 0,
  notes TEXT
);
