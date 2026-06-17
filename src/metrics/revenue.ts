import { type Kysely, type SelectQueryBuilder, sql } from 'kysely';
import type { MetricsDB } from './db/types';
import { collectingPairs } from './statusMap';

export interface RevenueRange {
  /** Inclusive lower bound. */
  from: Date;
  /** Exclusive upper bound — half-open [from, to) so adjacent ranges never double-count. */
  to: Date;
  currency: string;
}

export type Granularity = 'day' | 'week';

export interface Bucket {
  bucketStart: string; // ISO timestamp at the start of the day/week
  collectedCents: number;
}

/**
 * THE canonical "collected revenue" query. Every revenue number in this service
 * is derived from this one builder: half-open date range, single currency, and
 * the allow-listed (source, raw_status) pairs from statusMap — nothing else.
 *
 * Both the summary total and the day/week breakdown call this, so they cannot
 * disagree: same rows, same filter, the breakdown just adds a GROUP BY.
 */
function collectedBase(
  db: Kysely<MetricsDB>,
  range: RevenueRange,
): SelectQueryBuilder<MetricsDB, 'transactions', object> {
  const pairs = collectingPairs();
  return db
    .selectFrom('transactions')
    .where('currency', '=', range.currency)
    .where('occurred_at', '>=', range.from)
    .where('occurred_at', '<', range.to)
    .where((eb) =>
      eb.or(
        pairs.map((p) => eb.and([eb('source', '=', p.source), eb('raw_status', '=', p.status)])),
      ),
    );
}

const SUM_CENTS = sql<string>`coalesce(sum(amount_cents), 0)`;

/** Single total for the range. */
export async function revenueSummary(db: Kysely<MetricsDB>, range: RevenueRange): Promise<number> {
  const row = await collectedBase(db, range).select(SUM_CENTS.as('cents')).executeTakeFirstOrThrow();
  return Number(row.cents);
}

/** Day-by-day or week-by-week breakdown. Buckets sum EXACTLY to the summary. */
export async function revenueBreakdown(
  db: Kysely<MetricsDB>,
  range: RevenueRange,
  granularity: Granularity,
): Promise<Bucket[]> {
  const bucketExpr = sql<Date>`date_trunc(${sql.lit(granularity)}, occurred_at)`;
  const rows = await collectedBase(db, range)
    .select([bucketExpr.as('bucket'), SUM_CENTS.as('cents')])
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
    .execute();

  return rows.map((r) => ({
    bucketStart: new Date((r as { bucket: Date }).bucket).toISOString(),
    collectedCents: Number((r as { cents: string }).cents),
  }));
}
