import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { revenueBreakdown, revenueSummary, type RevenueRange } from '../../src/metrics/revenue';
import { seedTransactions } from '../../src/metrics/seed';
import { upsertTransactions } from '../../src/metrics/repository';
import { findUnclassifiedStatuses } from '../../src/metrics/audit';
import { metricsDb, resetMetricsDb } from '../helpers/db';

const usd = (from: string, to: string): RevenueRange => ({
  from: new Date(from),
  to: new Date(to),
  currency: 'USD',
});

beforeAll(async () => {
  await resetMetricsDb();
  await seedTransactions(metricsDb);
});

afterAll(async () => {
  await metricsDb.destroy();
});

describe('canonical revenue total', () => {
  it('sums only allow-listed statuses, in the requested currency, within [from,to)', async () => {
    // stripe succeeded 5000+2500+1500 + quickbooks paid 7000+2000 + square completed 6000+4000
    expect(await revenueSummary(metricsDb, usd('2026-06-01', '2026-07-01'))).toBe(28000);
  });

  it('isolates currency (EUR succeeded 5000 is not in the USD total)', async () => {
    expect(await revenueSummary(metricsDb, { ...usd('2026-06-01', '2026-07-01'), currency: 'EUR' })).toBe(5000);
  });

  it('respects the half-open range (an empty window is 0)', async () => {
    expect(await revenueSummary(metricsDb, usd('2026-01-01', '2026-02-01'))).toBe(0);
  });
});

describe('the two views ALWAYS agree (summary === Σ breakdown)', () => {
  const ranges = [
    usd('2026-06-01', '2026-07-01'),
    usd('2026-06-01', '2026-06-08'),
    usd('2026-06-05', '2026-06-12'),
    usd('2026-06-10', '2026-06-20'),
    usd('2026-01-01', '2026-02-01'), // empty
  ];

  for (const range of ranges) {
    it(`agrees for ${range.from.toISOString().slice(0, 10)}..${range.to.toISOString().slice(0, 10)}`, async () => {
      const summary = await revenueSummary(metricsDb, range);
      for (const granularity of ['day', 'week'] as const) {
        const buckets = await revenueBreakdown(metricsDb, range, granularity);
        const total = buckets.reduce((a, b) => a + b.collectedCents, 0);
        expect(total).toBe(summary);
      }
    });
  }
});

describe('allow-list completeness + no silent drift', () => {
  it('every status currently in the data is classified', async () => {
    expect(await findUnclassifiedStatuses(metricsDb)).toEqual([]);
  });

  it('a NEW unknown status is caught AND does not inflate revenue', async () => {
    const before = await revenueSummary(metricsDb, usd('2026-06-01', '2026-07-01'));

    // A source introduces a status we've never classified.
    await upsertTransactions(metricsDb, [
      {
        source: 'stripe',
        externalId: 'ch_disputed_1',
        amountCents: 99999,
        currency: 'USD',
        rawStatus: 'disputed',
        occurredAt: new Date('2026-06-15T10:00:00Z'),
        raw: {},
      },
    ]);

    // The completeness guard flags it...
    const unclassified = await findUnclassifiedStatuses(metricsDb);
    expect(unclassified).toContainEqual({ source: 'stripe', status: 'disputed' });

    // ...and revenue is UNCHANGED — an exclusion list would have counted it.
    const after = await revenueSummary(metricsDb, usd('2026-06-01', '2026-07-01'));
    expect(after).toBe(before);
  });
});
