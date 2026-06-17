import { sql } from 'kysely';
import { syncDb } from '../../src/sync/db/client';
import { metricsDb } from '../../src/metrics/db/client';

export { syncDb, metricsDb };

/** Reset Problem 1 tables to a known-empty state between tests. */
export async function resetSyncDb(): Promise<void> {
  await sql`TRUNCATE records, sync_state, sync_runs RESTART IDENTITY`.execute(syncDb);
}

/** Reset Problem 2 tables. */
export async function resetMetricsDb(): Promise<void> {
  await sql`TRUNCATE transactions RESTART IDENTITY`.execute(metricsDb);
}

export async function countRecords(source?: string): Promise<number> {
  let q = syncDb.selectFrom('records').select(syncDb.fn.countAll<string>().as('c'));
  if (source) q = q.where('source', '=', source);
  const row = await q.executeTakeFirstOrThrow();
  return Number(row.c);
}
