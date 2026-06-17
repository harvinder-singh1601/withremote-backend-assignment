import Stripe from 'stripe';
import { type Kysely, sql } from 'kysely';
import { env } from '../config/env';
import type { MetricsDB } from './db/types';
import { upsertTransactions, type TransactionInput } from './repository';

const d = (iso: string): Date => new Date(iso);

// ── Simulated source systems with DIFFERENT status vocabularies ──────────────
// The whole point of Problem 2: three sources, three vocabularies, one number.

const STRIPE_FIXTURE: TransactionInput[] = [
  txn('stripe', 'st_1', 5000, 'USD', 'succeeded', '2026-06-01T10:00:00Z'),
  txn('stripe', 'st_2', 2500, 'USD', 'succeeded', '2026-06-02T11:00:00Z'),
  txn('stripe', 'st_3', 9999, 'USD', 'failed', '2026-06-02T12:00:00Z'),
  txn('stripe', 'st_4', 4000, 'USD', 'refunded', '2026-06-08T09:00:00Z'),
  txn('stripe', 'st_5', 1500, 'USD', 'succeeded', '2026-06-09T15:00:00Z'),
  txn('stripe', 'st_eur', 5000, 'EUR', 'succeeded', '2026-06-06T15:00:00Z'), // currency filter check
];

const QUICKBOOKS_FIXTURE: TransactionInput[] = [
  txn('quickbooks', 'qb_1', 7000, 'USD', 'paid', '2026-06-03T10:00:00Z'),
  txn('quickbooks', 'qb_2', 3000, 'USD', 'pending', '2026-06-04T10:00:00Z'),
  txn('quickbooks', 'qb_3', 1000, 'USD', 'voided', '2026-06-10T10:00:00Z'),
  txn('quickbooks', 'qb_4', 2000, 'USD', 'paid', '2026-06-11T10:00:00Z'),
];

const SQUARE_FIXTURE: TransactionInput[] = [
  txn('square', 'sq_1', 6000, 'USD', 'completed', '2026-06-05T10:00:00Z'),
  txn('square', 'sq_2', 500, 'USD', 'failed', '2026-06-05T11:00:00Z'),
  txn('square', 'sq_3', 4000, 'USD', 'completed', '2026-06-12T10:00:00Z'),
];

function txn(
  source: string,
  externalId: string,
  amountCents: number,
  currency: string,
  rawStatus: string,
  occurredAt: string,
): TransactionInput {
  return { source, externalId, amountCents, currency, rawStatus, occurredAt: d(occurredAt), raw: { source, externalId, rawStatus } };
}

/** Stripe charges from the real test-mode account when a key is present; else fixtures. */
async function stripeTransactions(): Promise<TransactionInput[]> {
  if (!env.STRIPE_SECRET_KEY) return STRIPE_FIXTURE;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const charges = await stripe.charges.list({ limit: 100 }).autoPagingToArray({ limit: 1000 });
  return charges.map((c) => ({
    source: 'stripe',
    externalId: c.id,
    amountCents: c.amount,
    currency: c.currency.toUpperCase(),
    rawStatus: c.status,
    occurredAt: new Date(c.created * 1000),
    raw: c,
  }));
}

export interface SeedResult {
  rowsUpserted: number;
  /** Total rows after seeding — stays constant across re-runs, proving no duplication. */
  totalRows: number;
  stripeMode: 'live' | 'fixture';
  bySource: Record<string, number>;
}

/** Idempotent seed: safe to run repeatedly (re-seeding never duplicates). */
export async function seedTransactions(db: Kysely<MetricsDB>): Promise<SeedResult> {
  const stripe = await stripeTransactions();
  const all = [...stripe, ...QUICKBOOKS_FIXTURE, ...SQUARE_FIXTURE];
  const { written } = await upsertTransactions(db, all);

  const bySource: Record<string, number> = {};
  for (const t of all) bySource[t.source] = (bySource[t.source] ?? 0) + 1;

  const totalRow = await db
    .selectFrom('transactions')
    .select(sql<string>`count(*)`.as('c'))
    .executeTakeFirstOrThrow();

  return {
    rowsUpserted: written,
    totalRows: Number(totalRow.c),
    stripeMode: env.STRIPE_SECRET_KEY ? 'live' : 'fixture',
    bySource,
  };
}
