import { createHash } from 'node:crypto';
import { type Kysely, sql } from 'kysely';
import type { NormalizedRecord, SourceName } from './domain/normalized';
import type { SyncDB, SyncStateRow } from './db/types';

/**
 * Stable content hash over the meaningful normalized fields (NOT synced_at).
 * Re-deriving the same source record yields the same hash, so an unchanged
 * record never triggers a write — the core of idempotency.
 */
export function contentHash(r: NormalizedRecord): string {
  const canonical = JSON.stringify([
    r.recordType,
    r.title,
    r.email,
    r.amountCents,
    r.currency,
    r.status,
    r.occurredAt?.toISOString() ?? null,
    r.sourceCreatedAt?.toISOString() ?? null,
    r.sourceUpdatedAt?.toISOString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Idempotent bulk upsert. The same record (same source+external_id) is one row
 * forever; the row is only rewritten when its content actually changed. This is
 * the single write path used by BOTH the batch sync and the webhook handler, so
 * a webhook firing twice or a back-to-back re-run produces zero duplicates.
 *
 * Returns the number of rows actually inserted-or-updated (unchanged rows that
 * hit the `WHERE content_hash IS DISTINCT FROM` guard are not counted).
 */
export async function upsertRecords(
  db: Kysely<SyncDB>,
  records: NormalizedRecord[],
): Promise<{ written: number }> {
  if (records.length === 0) return { written: 0 };

  const rows = records.map((r) => ({
    source: r.source,
    external_id: r.externalId,
    record_type: r.recordType,
    title: r.title,
    email: r.email,
    amount_cents: r.amountCents,
    currency: r.currency,
    status: r.status,
    occurred_at: r.occurredAt,
    source_created_at: r.sourceCreatedAt,
    source_updated_at: r.sourceUpdatedAt,
    raw: JSON.stringify(r.raw ?? null),
    content_hash: contentHash(r),
  }));

  const result = await db
    .insertInto('records')
    .values(rows)
    .onConflict((oc) =>
      oc
        .columns(['source', 'external_id'])
        .doUpdateSet((eb) => ({
          record_type: eb.ref('excluded.record_type'),
          title: eb.ref('excluded.title'),
          email: eb.ref('excluded.email'),
          amount_cents: eb.ref('excluded.amount_cents'),
          currency: eb.ref('excluded.currency'),
          status: eb.ref('excluded.status'),
          occurred_at: eb.ref('excluded.occurred_at'),
          source_created_at: eb.ref('excluded.source_created_at'),
          source_updated_at: eb.ref('excluded.source_updated_at'),
          raw: eb.ref('excluded.raw'),
          content_hash: eb.ref('excluded.content_hash'),
          synced_at: sql`now()`,
        }))
        // Skip the write entirely when nothing changed — keeps re-runs cheap and
        // makes "rows written" a truthful change count.
        .where(sql<boolean>`records.content_hash IS DISTINCT FROM excluded.content_hash`),
    )
    .executeTakeFirst();

  return { written: Number(result.numInsertedOrUpdatedRows ?? 0n) };
}

// ── sync_state ───────────────────────────────────────────────────────────────

export async function getSyncState(
  db: Kysely<SyncDB>,
  source: SourceName,
): Promise<SyncStateRow | undefined> {
  return db.selectFrom('sync_state').selectAll().where('source', '=', source).executeTakeFirst();
}

export async function saveSyncState(
  db: Kysely<SyncDB>,
  source: SourceName,
  patch: {
    cursor?: string | null;
    cursorType?: string | null;
    health: 'healthy' | 'degraded' | 'failed';
    lastError?: string | null;
    lastFullSyncAt?: Date | null;
    lastIncrementalSyncAt?: Date | null;
  },
): Promise<void> {
  await db
    .insertInto('sync_state')
    .values({
      source,
      cursor: patch.cursor ?? null,
      cursor_type: patch.cursorType ?? null,
      health: patch.health,
      last_error: patch.lastError ?? null,
      last_full_sync_at: patch.lastFullSyncAt ?? null,
      last_incremental_sync_at: patch.lastIncrementalSyncAt ?? null,
    })
    .onConflict((oc) =>
      oc.column('source').doUpdateSet((eb) => ({
        cursor: eb.ref('excluded.cursor'),
        cursor_type: eb.ref('excluded.cursor_type'),
        health: eb.ref('excluded.health'),
        last_error: eb.ref('excluded.last_error'),
        // Preserve prior timestamps when this run didn't set them.
        last_full_sync_at: sql`coalesce(excluded.last_full_sync_at, sync_state.last_full_sync_at)`,
        last_incremental_sync_at: sql`coalesce(excluded.last_incremental_sync_at, sync_state.last_incremental_sync_at)`,
        updated_at: sql`now()`,
      })),
    )
    .execute();
}

// ── sync_runs (audit trail) ───────────────────────────────────────────────────

export async function startRun(
  db: Kysely<SyncDB>,
  source: SourceName,
  mode: 'incremental' | 'full',
): Promise<string> {
  const row = await db
    .insertInto('sync_runs')
    .values({ source, mode, outcome: 'running' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function finishRun(
  db: Kysely<SyncDB>,
  runId: string,
  patch: {
    mode: 'incremental' | 'full';
    outcome: 'success' | 'degraded' | 'failed';
    upserted: number;
    skippedInvalid: number;
    fellBackToFull: boolean;
    error?: string | null;
  },
): Promise<void> {
  await db
    .updateTable('sync_runs')
    .set({
      mode: patch.mode,
      outcome: patch.outcome,
      upserted: patch.upserted,
      skipped_invalid: patch.skippedInvalid,
      fell_back_to_full: patch.fellBackToFull,
      error: patch.error ?? null,
      finished_at: sql`now()`,
    })
    .where('id', '=', runId)
    .execute();
}
