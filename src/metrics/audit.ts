import { type Kysely } from 'kysely';
import type { MetricsDB } from './db/types';
import { classify, type SourceStatus } from './statusMap';

/** Every distinct (source, raw_status) pair actually present in the data. */
export async function distinctStatuses(db: Kysely<MetricsDB>): Promise<SourceStatus[]> {
  const rows = await db
    .selectFrom('transactions')
    .select(['source', 'raw_status'])
    .distinct()
    .execute();
  return rows.map((r) => ({ source: r.source, status: r.raw_status }));
}

/**
 * Statuses present in the data that the allow-list does NOT classify. These are
 * the silent-drift risk: with an exclusion list they'd count as revenue. Here
 * they count as nothing and show up loudly — both at runtime (the audit endpoint)
 * and in CI (the completeness test).
 */
export async function findUnclassifiedStatuses(db: Kysely<MetricsDB>): Promise<SourceStatus[]> {
  const seen = await distinctStatuses(db);
  return seen.filter((s) => classify(s.source, s.status) === 'unknown');
}
