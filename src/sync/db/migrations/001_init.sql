-- Problem 1: normalized sync store (Supabase project A)

-- One normalized table for all three differently-shaped sources.
CREATE TABLE IF NOT EXISTS records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text        NOT NULL,           -- 'hubspot' | 'stripe' | 'google_calendar'
  external_id        text        NOT NULL,           -- the source's own id
  record_type        text        NOT NULL,           -- 'contact' | 'payment' | 'event'
  title              text,
  email              text,
  amount_cents       bigint,                          -- payments only; integer cents, never float
  currency           text,
  status             text,
  occurred_at        timestamptz,                     -- event start / charge created
  source_created_at  timestamptz,
  source_updated_at  timestamptz,
  raw                jsonb       NOT NULL,            -- original payload, kept for auditability
  content_hash       text        NOT NULL,            -- change-detection for idempotent upsert
  synced_at          timestamptz NOT NULL DEFAULT now(),
  -- Natural key: the same source record is one row, forever. This is what makes
  -- a webhook firing twice (or a back-to-back re-run) a no-op instead of a dup.
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS records_source_type_idx ON records (source, record_type);
CREATE INDEX IF NOT EXISTS records_occurred_at_idx ON records (occurred_at);

-- Per-source cursor + health. Drives incremental fetch and the fallback decision.
CREATE TABLE IF NOT EXISTS sync_state (
  source                    text PRIMARY KEY,
  cursor                    text,
  cursor_type               text,                     -- 'timestamp' | 'sync_token' | 'object_id'
  health                    text NOT NULL DEFAULT 'healthy', -- healthy | degraded | failed
  last_error                text,
  last_full_sync_at         timestamptz,
  last_incremental_sync_at  timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- Audit trail: every run, what mode, how many rows, whether it fell back. Demo surface.
CREATE TABLE IF NOT EXISTS sync_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source             text NOT NULL,
  mode               text NOT NULL,                   -- incremental | full
  outcome            text NOT NULL,                   -- success | degraded | failed
  upserted           integer NOT NULL DEFAULT 0,
  skipped_invalid    integer NOT NULL DEFAULT 0,
  fell_back_to_full  boolean NOT NULL DEFAULT false,
  error              text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz
);

CREATE INDEX IF NOT EXISTS sync_runs_source_started_idx ON sync_runs (source, started_at DESC);
