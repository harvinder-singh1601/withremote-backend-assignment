import type { NormalizedRecord, SourceName } from '../domain/normalized';
import { StaleCursorError, type CursorType, type DataSource, type FetchResult } from '../ports/source';
import { googleEventToNormalized, hubspotToNormalized, stripeToNormalized } from './normalize';

export interface FixtureOptions {
  name: SourceName;
  cursorType: CursorType;
  toNormalized: (raw: unknown) => NormalizedRecord;
  fullData: unknown[];
  /** Items returned by an incremental fetch (default: none changed). */
  incrementalData?: unknown[];
  /** When true, an incremental fetch throws StaleCursorError (drives the fallback demo). */
  staleCursor?: boolean;
  /** When true, every fetch throws — simulates the source being down. */
  down?: boolean;
  nextCursor?: string;
}

/**
 * In-memory DataSource used (a) offline / when a live credential is absent, and
 * (b) by tests to deterministically drive every edge case: idempotency, stale
 * cursor → full backfill, garbage records, and a source being down.
 */
export class FixtureSource implements DataSource {
  readonly name: SourceName;
  readonly cursorType: CursorType;
  private readonly opts: FixtureOptions;

  constructor(opts: FixtureOptions) {
    this.name = opts.name;
    this.cursorType = opts.cursorType;
    this.opts = opts;
  }

  toNormalized(rawItem: unknown): NormalizedRecord {
    return this.opts.toNormalized(rawItem);
  }

  async fetchFull(): Promise<FetchResult> {
    if (this.opts.down) throw new Error(`${this.name} is down (simulated)`);
    return { raw: this.opts.fullData, nextCursor: this.opts.nextCursor ?? 'cursor-1' };
  }

  async fetchIncremental(_cursor: string): Promise<FetchResult> {
    if (this.opts.down) throw new Error(`${this.name} is down (simulated)`);
    if (this.opts.staleCursor) {
      throw new StaleCursorError(this.name, 'fixture cursor is stale (simulated 410)');
    }
    return { raw: this.opts.incrementalData ?? [], nextCursor: this.opts.nextCursor ?? 'cursor-2' };
  }
}

// ── Canned, realistically-shaped sample payloads ─────────────────────────────
// These double as recorded fixtures: the exact shapes each real API returns.

export const HUBSPOT_FIXTURE: unknown[] = [
  {
    id: '101',
    properties: {
      firstname: 'Alice',
      lastname: 'Nguyen',
      email: 'alice@example.com',
      createdate: '2026-05-01T10:00:00Z',
      lastmodifieddate: '2026-05-20T12:00:00Z',
    },
  },
  {
    id: '102',
    properties: {
      firstname: 'Bob',
      lastname: 'Martinez',
      email: 'bob@example.com',
      createdate: '2026-05-03T09:30:00Z',
      lastmodifieddate: '2026-05-21T08:15:00Z',
    },
  },
  {
    id: '103',
    properties: {
      firstname: 'Chitra',
      lastname: 'Rao',
      email: 'chitra@example.com',
      createdate: '2026-05-05T14:45:00Z',
      lastmodifieddate: '2026-05-22T16:00:00Z',
    },
  },
];

export const STRIPE_FIXTURE: unknown[] = [
  {
    id: 'ch_3001',
    object: 'charge',
    amount: 4999,
    currency: 'usd',
    status: 'succeeded',
    created: 1748773800, // 2025-06-01T... unix seconds
    description: 'Pro plan — monthly',
    billing_details: { email: 'alice@example.com' },
  },
  {
    id: 'ch_3002',
    object: 'charge',
    amount: 12000,
    currency: 'usd',
    status: 'succeeded',
    created: 1748860200,
    description: 'Team seats x4',
    billing_details: { email: 'bob@example.com' },
  },
  {
    id: 'ch_3003',
    object: 'charge',
    amount: 2500,
    currency: 'usd',
    status: 'failed',
    created: 1748946600,
    description: 'Add-on',
    billing_details: { email: 'chitra@example.com' },
  },
];

export const GOOGLE_FIXTURE: unknown[] = [
  {
    id: 'evt_a1',
    status: 'confirmed',
    summary: 'Customer onboarding call',
    created: '2026-05-10T09:00:00Z',
    updated: '2026-05-11T09:00:00Z',
    start: { dateTime: '2026-06-02T15:00:00Z' },
    creator: { email: 'alice@example.com' },
  },
  {
    id: 'evt_a2',
    status: 'confirmed',
    summary: 'Quarterly review',
    created: '2026-05-12T11:00:00Z',
    updated: '2026-05-13T11:00:00Z',
    start: { date: '2026-06-10' }, // all-day event
    creator: { email: 'bob@example.com' },
  },
  {
    id: 'evt_a3',
    status: 'cancelled', // cancelled events arrive with minimal fields
    created: '2026-05-14T08:00:00Z',
    updated: '2026-05-15T08:00:00Z',
  },
];

/** Build the three fixture-backed sources with their canned data + real mappers. */
export function buildFixtureSources(): DataSource[] {
  return [
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
    }),
    new FixtureSource({
      name: 'google_calendar',
      cursorType: 'sync_token',
      toNormalized: googleEventToNormalized,
      fullData: GOOGLE_FIXTURE,
    }),
  ];
}
