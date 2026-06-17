import type { ColumnType, Generated, Selectable } from 'kysely';

/** A timestamp column: returns Date, accepts Date | ISO string. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** BIGINT comes back from pg as a string; we accept number on write. */
type BigIntCol = ColumnType<string | null, number | null, number | null>;
/** jsonb: returned parsed (unknown), written as a JSON string. */
type Jsonb = ColumnType<unknown, string, string>;

export interface RecordsTable {
  id: Generated<string>;
  source: string;
  external_id: string;
  record_type: string;
  title: string | null;
  email: string | null;
  amount_cents: BigIntCol;
  currency: string | null;
  status: string | null;
  occurred_at: NullableTimestamp;
  source_created_at: NullableTimestamp;
  source_updated_at: NullableTimestamp;
  raw: Jsonb;
  content_hash: string;
  synced_at: Generated<Timestamp>;
}

export interface SyncStateTable {
  source: string; // PK
  cursor: string | null;
  cursor_type: string | null;
  health: ColumnType<'healthy' | 'degraded' | 'failed', string, string>;
  last_error: string | null;
  last_full_sync_at: NullableTimestamp;
  last_incremental_sync_at: NullableTimestamp;
  updated_at: Generated<Timestamp>;
}

export interface SyncRunsTable {
  id: Generated<string>;
  source: string;
  mode: string; // 'incremental' | 'full'
  outcome: string; // 'success' | 'degraded' | 'failed'
  upserted: Generated<number>;
  skipped_invalid: Generated<number>;
  fell_back_to_full: Generated<boolean>;
  error: string | null;
  started_at: Generated<Timestamp>;
  finished_at: NullableTimestamp;
}

export interface SyncDB {
  records: RecordsTable;
  sync_state: SyncStateTable;
  sync_runs: SyncRunsTable;
}

export type RecordRow = Selectable<RecordsTable>;
export type SyncStateRow = Selectable<SyncStateTable>;
export type SyncRunRow = Selectable<SyncRunsTable>;
