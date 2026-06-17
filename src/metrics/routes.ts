import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { metricsDb } from './db/client';
import { revenueBreakdown, revenueSummary, type Granularity, type RevenueRange } from './revenue';
import { seedTransactions } from './seed';
import { distinctStatuses, findUnclassifiedStatuses } from './audit';

interface RangeQuery {
  from?: string;
  to?: string;
  currency?: string;
}

const rangeSchema = {
  from: { type: 'string', description: 'ISO date, inclusive (default: epoch)' },
  to: { type: 'string', description: 'ISO date, exclusive (default: now+1d)' },
  currency: { type: 'string', default: 'USD' },
} as const;

function parseRange(q: RangeQuery): RevenueRange {
  const from = q.from ? new Date(q.from) : new Date('1970-01-01T00:00:00Z');
  const to = q.to ? new Date(q.to) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('invalid from/to date');
  }
  return { from, to, currency: (q.currency ?? 'USD').toUpperCase() };
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  // ── Seed (pull Stripe test charges + simulated sources) ─────────────────────
  app.post(
    '/metrics/seed',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Seed transactions from Stripe (test) + simulated sources. Idempotent.',
      },
    },
    async () => seedTransactions(metricsDb),
  );

  // ── Summary total ───────────────────────────────────────────────────────────
  app.get<{ Querystring: RangeQuery }>(
    '/metrics/revenue/summary',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Total collected revenue for a date range (single canonical number)',
        querystring: { type: 'object', properties: { ...rangeSchema } },
      },
    },
    async (req) => {
      const range = parseRange(req.query);
      const totalCollectedCents = await revenueSummary(metricsDb, range);
      return {
        total_collected_cents: totalCollectedCents,
        currency: range.currency,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      };
    },
  );

  // ── Day/week breakdown ──────────────────────────────────────────────────────
  app.get<{ Querystring: RangeQuery & { granularity?: Granularity } }>(
    '/metrics/revenue/breakdown',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Day-by-day or week-by-week breakdown (sums exactly to the summary)',
        querystring: {
          type: 'object',
          properties: {
            ...rangeSchema,
            granularity: { type: 'string', enum: ['day', 'week'], default: 'day' },
          },
        },
      },
    },
    async (req) => {
      const range = parseRange(req.query);
      const granularity: Granularity = req.query.granularity === 'week' ? 'week' : 'day';
      const buckets = await revenueBreakdown(metricsDb, range, granularity);
      return {
        currency: range.currency,
        granularity,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        buckets,
      };
    },
  );

  // ── Reconcile: prove the two views agree ────────────────────────────────────
  app.get<{ Querystring: RangeQuery & { granularity?: Granularity } }>(
    '/metrics/revenue/reconcile',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Returns summary + breakdown and asserts they agree (live drift check)',
        querystring: {
          type: 'object',
          properties: {
            ...rangeSchema,
            granularity: { type: 'string', enum: ['day', 'week'], default: 'day' },
          },
        },
      },
    },
    async (req) => {
      const range = parseRange(req.query);
      const granularity: Granularity = req.query.granularity === 'week' ? 'week' : 'day';
      const [summary, buckets] = await Promise.all([
        revenueSummary(metricsDb, range),
        revenueBreakdown(metricsDb, range, granularity),
      ]);
      const breakdownTotal = buckets.reduce((acc, b) => acc + b.collectedCents, 0);
      return {
        currency: range.currency,
        summary_total_cents: summary,
        breakdown_total_cents: breakdownTotal,
        agree: summary === breakdownTotal,
        bucket_count: buckets.length,
      };
    },
  );

  // ── Status audit: surface any status the allow-list doesn't classify ────────
  app.get(
    '/metrics/status-audit',
    {
      schema: {
        tags: ['metrics'],
        summary: 'Distinct statuses in the data + any the allow-list does not classify',
      },
    },
    async () => {
      const [seen, unclassified] = await Promise.all([
        distinctStatuses(metricsDb),
        findUnclassifiedStatuses(metricsDb),
      ]);
      return { distinct: seen, unclassified, drift_risk: unclassified.length > 0 };
    },
  );

  // ── Inspect raw transactions ────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: number } }>(
    '/metrics/transactions',
    {
      schema: {
        tags: ['metrics'],
        summary: 'List ingested transactions (with their original status vocabulary)',
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (req) => {
      const rows = await metricsDb
        .selectFrom('transactions')
        .selectAll()
        .orderBy('occurred_at', 'desc')
        .limit(req.query.limit ?? 100)
        .execute();
      const total = await metricsDb
        .selectFrom('transactions')
        .select(sql<string>`count(*)`.as('c'))
        .executeTakeFirstOrThrow();
      return { total: Number(total.c), count: rows.length, transactions: rows };
    },
  );
}
