import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runSourceSync, runSync } from '../../src/sync/orchestrator';
import { getSyncState, upsertRecords } from '../../src/sync/repository';
import {
  FixtureSource,
  GOOGLE_FIXTURE,
  HUBSPOT_FIXTURE,
  STRIPE_FIXTURE,
  buildFixtureSources,
} from '../../src/sync/adapters/fixtures';
import {
  googleEventToNormalized,
  hubspotToNormalized,
  stripeToNormalized,
} from '../../src/sync/adapters/normalize';
import { countRecords, metricsDb, resetSyncDb, syncDb } from '../helpers/db';

beforeEach(async () => {
  await resetSyncDb();
});

afterAll(async () => {
  await syncDb.destroy();
  await metricsDb.destroy();
});

describe('sync pipeline — normalization + landing', () => {
  it('lands all three differently-shaped sources into one normalized schema', async () => {
    const summaries = await runSync(syncDb, buildFixtureSources());

    expect(summaries.every((s) => s.outcome === 'success')).toBe(true);
    expect(await countRecords('hubspot')).toBe(HUBSPOT_FIXTURE.length);
    expect(await countRecords('stripe')).toBe(STRIPE_FIXTURE.length);
    expect(await countRecords('google_calendar')).toBe(GOOGLE_FIXTURE.length);

    // Spot-check normalization: a Stripe charge became a 'payment' with integer cents.
    const charge = await syncDb
      .selectFrom('records')
      .selectAll()
      .where('source', '=', 'stripe')
      .where('external_id', '=', 'ch_3001')
      .executeTakeFirstOrThrow();
    expect(charge.record_type).toBe('payment');
    expect(Number(charge.amount_cents)).toBe(4999);
    expect(charge.currency).toBe('USD');
  });
});

describe('idempotency — no duplicate rows', () => {
  it('re-running back-to-back never duplicates (webhook-fires-twice equivalent)', async () => {
    const sources = buildFixtureSources();
    await runSync(syncDb, sources);
    const afterFirst = await countRecords();

    // Run again — sources now have a cursor, incremental returns nothing changed.
    await runSync(syncDb, sources);
    expect(await countRecords()).toBe(afterFirst);
  });

  it('upserting the identical batch twice writes 0 the second time', async () => {
    const records = HUBSPOT_FIXTURE.map(hubspotToNormalized);
    const first = await upsertRecords(syncDb, records);
    const second = await upsertRecords(syncDb, records);
    expect(first.written).toBe(records.length);
    expect(second.written).toBe(0); // unchanged content → no write
    expect(await countRecords('hubspot')).toBe(records.length);
  });

  it('a changed record updates in place (still one row)', async () => {
    const [first] = STRIPE_FIXTURE;
    await upsertRecords(syncDb, [stripeToNormalized(first)]);
    const changed = { ...(first as Record<string, unknown>), status: 'refunded' };
    const res = await upsertRecords(syncDb, [stripeToNormalized(changed)]);
    expect(res.written).toBe(1);
    expect(await countRecords('stripe')).toBe(1);
    const row = await syncDb
      .selectFrom('records')
      .selectAll()
      .where('external_id', '=', 'ch_3001')
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('refunded');
  });
});

describe('stale cursor → full backfill', () => {
  it('falls back to a full fetch when the incremental cursor is rejected (e.g. 410)', async () => {
    // First run: a normal full sync to establish a cursor (next run goes incremental).
    await runSourceSync(
      syncDb,
      new FixtureSource({
        name: 'google_calendar',
        cursorType: 'sync_token',
        toNormalized: googleEventToNormalized,
        fullData: GOOGLE_FIXTURE,
      }),
    );
    const seeded = await getSyncState(syncDb, 'google_calendar');
    expect(seeded?.cursor).toBeTruthy();

    // Second run: incremental throws StaleCursorError → orchestrator must full-backfill.
    const stale = new FixtureSource({
      name: 'google_calendar',
      cursorType: 'sync_token',
      toNormalized: googleEventToNormalized,
      fullData: GOOGLE_FIXTURE,
      staleCursor: true,
    });
    const summary = await runSourceSync(syncDb, stale);
    expect(summary.fellBackToFull).toBe(true);
    expect(summary.mode).toBe('full');
    expect(summary.outcome).toBe('success');
    expect(await countRecords('google_calendar')).toBe(GOOGLE_FIXTURE.length);
  });
});

describe('fault isolation — one source down, the others still land', () => {
  it('keeps going when a source is down', async () => {
    const sources = [
      new FixtureSource({
        name: 'hubspot',
        cursorType: 'timestamp',
        toNormalized: hubspotToNormalized,
        fullData: HUBSPOT_FIXTURE,
      }),
      new FixtureSource({
        name: 'stripe',
        cursorType: 'object_id',
        toNormalized: stripeToNormalized,
        fullData: STRIPE_FIXTURE,
        down: true, // simulate Stripe being down
      }),
      new FixtureSource({
        name: 'google_calendar',
        cursorType: 'sync_token',
        toNormalized: googleEventToNormalized,
        fullData: GOOGLE_FIXTURE,
      }),
    ];

    const summaries = await runSync(syncDb, sources);
    const byName = Object.fromEntries(summaries.map((s) => [s.source, s]));

    expect(byName.stripe!.outcome).toBe('failed');
    expect(byName.hubspot!.outcome).toBe('success');
    expect(byName.google_calendar!.outcome).toBe('success');

    // The two healthy sources landed their data despite Stripe failing.
    expect(await countRecords('hubspot')).toBe(HUBSPOT_FIXTURE.length);
    expect(await countRecords('google_calendar')).toBe(GOOGLE_FIXTURE.length);
    expect(await countRecords('stripe')).toBe(0);

    const stripeState = await getSyncState(syncDb, 'stripe');
    expect(stripeState?.health).toBe('failed');
  });
});

describe('garbage tolerance — quarantine bad records, keep the good ones', () => {
  it('skips malformed records and still lands the valid ones (degraded, not failed)', async () => {
    const dirty = [
      ...HUBSPOT_FIXTURE,
      { properties: { firstname: 'No', lastname: 'Id' } }, // missing id → invalid
      { id: 42 }, // wrong id type → invalid
    ];
    const source = new FixtureSource({
      name: 'hubspot',
      cursorType: 'timestamp',
      toNormalized: hubspotToNormalized,
      fullData: dirty,
    });

    const summary = await runSourceSync(syncDb, source);
    expect(summary.skippedInvalid).toBe(2);
    expect(summary.outcome).toBe('degraded');
    expect(await countRecords('hubspot')).toBe(HUBSPOT_FIXTURE.length);
  });
});
