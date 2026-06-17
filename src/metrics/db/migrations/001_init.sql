-- Problem 2: normalized transactions store (Supabase project B)

CREATE TABLE IF NOT EXISTS transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text        NOT NULL,        -- 'stripe' | 'quickbooks' | 'square'
  external_id  text        NOT NULL,
  amount_cents bigint      NOT NULL,         -- integer cents — no floating point, no rounding drift
  currency     text        NOT NULL,
  raw_status   text        NOT NULL,         -- the source's own status vocabulary, untouched
  occurred_at  timestamptz NOT NULL,
  raw          jsonb       NOT NULL,
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)               -- idempotent seeding / re-ingest
);

CREATE INDEX IF NOT EXISTS transactions_occurred_at_idx ON transactions (occurred_at);
CREATE INDEX IF NOT EXISTS transactions_source_status_idx ON transactions (source, raw_status);
