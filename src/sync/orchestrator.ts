import type { Kysely } from 'kysely';
import type { SyncDB } from './db/types';
import { NormalizedRecord, type SourceName } from './domain/normalized';
import { StaleCursorError, type DataSource } from './ports/source';
import { finishRun, getSyncState, saveSyncState, startRun, upsertRecords } from './repository';

export interface RunSummary {
  source: SourceName;
  mode: 'incremental' | 'full';
  outcome: 'success' | 'degraded' | 'failed';
  upserted: number;
  skippedInvalid: number;
  fellBackToFull: boolean;
  error: string | null;
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const noopLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Normalize a raw batch. Each item is validated independently: a malformed item
 * (source "returns garbage") is counted and quarantined, never fatal. Items are
 * also de-duplicated by natural key so a single batch can't break the upsert.
 */
function normalizeBatch(
  source: DataSource,
  raw: unknown[],
): { records: NormalizedRecord[]; skippedInvalid: number } {
  const byKey = new Map<string, NormalizedRecord>();
  let skippedInvalid = 0;

  for (const item of raw) {
    try {
      const normalized = NormalizedRecord.parse(source.toNormalized(item));
      byKey.set(normalized.externalId, normalized); // last write wins within a batch
    } catch {
      skippedInvalid++;
    }
  }

  return { records: [...byKey.values()], skippedInvalid };
}

/**
 * Sync ONE source end to end. Never throws — any failure is captured into the
 * returned summary and the source's `sync_state`, so a sibling source is never
 * affected. This is the fault-isolation boundary.
 */
export async function runSourceSync(
  db: Kysely<SyncDB>,
  source: DataSource,
  logger: Logger = noopLogger,
): Promise<RunSummary> {
  const state = await getSyncState(db, source.name);
  const hasCursor = state?.cursor != null && state.cursor !== '';
  let mode: 'incremental' | 'full' = hasCursor ? 'incremental' : 'full';
  let fellBackToFull = false;

  const runId = await startRun(db, source.name, mode);

  try {
    let fetched;
    if (hasCursor) {
      try {
        fetched = await source.fetchIncremental(state!.cursor!);
      } catch (err) {
        if (err instanceof StaleCursorError) {
          // The headline requirement: cursor went stale (e.g. Google 410) — do a
          // full backfill instead of losing data or crashing.
          logger.warn(
            { source: source.name, err: err.message },
            'incremental cursor stale → falling back to full backfill',
          );
          fellBackToFull = true;
          mode = 'full';
          fetched = await source.fetchFull();
        } else {
          throw err;
        }
      }
    } else {
      fetched = await source.fetchFull();
    }

    const { records, skippedInvalid } = normalizeBatch(source, fetched.raw);
    const { written } = await upsertRecords(db, records);

    const outcome: RunSummary['outcome'] = skippedInvalid > 0 ? 'degraded' : 'success';
    const now = new Date();

    await saveSyncState(db, source.name, {
      cursor: fetched.nextCursor,
      cursorType: source.cursorType,
      health: outcome === 'degraded' ? 'degraded' : 'healthy',
      lastError: skippedInvalid > 0 ? `${skippedInvalid} record(s) quarantined` : null,
      lastFullSyncAt: mode === 'full' ? now : null,
      lastIncrementalSyncAt: mode === 'incremental' ? now : null,
    });

    await finishRun(db, runId, {
      mode,
      outcome,
      upserted: written,
      skippedInvalid,
      fellBackToFull,
      error: null,
    });

    logger.info(
      { source: source.name, mode, written, skippedInvalid, fellBackToFull },
      'source sync complete',
    );

    return { source: source.name, mode, outcome, upserted: written, skippedInvalid, fellBackToFull, error: null };
  } catch (err) {
    // Source down / returned something unparseable at the batch level / DB hiccup.
    // Isolate it: mark this source failed and let the others proceed untouched.
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ source: source.name, err: message }, 'source sync failed (isolated)');

    await saveSyncState(db, source.name, {
      cursor: state?.cursor ?? null, // keep the cursor; retry incremental next time
      cursorType: source.cursorType,
      health: 'failed',
      lastError: message,
    }).catch(() => {});

    await finishRun(db, runId, {
      mode,
      outcome: 'failed',
      upserted: 0,
      skippedInvalid: 0,
      fellBackToFull,
      error: message,
    }).catch(() => {});

    return { source: source.name, mode, outcome: 'failed', upserted: 0, skippedInvalid: 0, fellBackToFull, error: message };
  }
}

/**
 * Run several sources. They proceed INDEPENDENTLY (Promise.allSettled): one
 * source being down or returning garbage never wedges the others.
 */
export async function runSync(
  db: Kysely<SyncDB>,
  sources: DataSource[],
  only: SourceName | 'all' = 'all',
  logger: Logger = noopLogger,
): Promise<RunSummary[]> {
  const selected = only === 'all' ? sources : sources.filter((s) => s.name === only);
  const settled = await Promise.allSettled(selected.map((s) => runSourceSync(db, s, logger)));

  return settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          source: selected[i]!.name,
          mode: 'full' as const,
          outcome: 'failed' as const,
          upserted: 0,
          skippedInvalid: 0,
          fellBackToFull: false,
          error: String(r.reason),
        },
  );
}
