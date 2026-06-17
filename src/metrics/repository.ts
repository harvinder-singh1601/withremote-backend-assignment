import { type Kysely } from 'kysely';
import type { MetricsDB } from './db/types';

export interface TransactionInput {
  source: string;
  externalId: string;
  amountCents: number;
  currency: string;
  rawStatus: string;
  occurredAt: Date;
  raw: unknown;
}

/** Idempotent upsert keyed on (source, external_id) — re-seeding never duplicates. */
export async function upsertTransactions(
  db: Kysely<MetricsDB>,
  txns: TransactionInput[],
): Promise<{ written: number }> {
  if (txns.length === 0) return { written: 0 };

  // De-dupe within the batch so ON CONFLICT can't try to touch a row twice.
  const byKey = new Map<string, TransactionInput>();
  for (const t of txns) byKey.set(`${t.source}:${t.externalId}`, t);

  const rows = [...byKey.values()].map((t) => ({
    source: t.source,
    external_id: t.externalId,
    amount_cents: t.amountCents,
    currency: t.currency,
    raw_status: t.rawStatus,
    occurred_at: t.occurredAt,
    raw: JSON.stringify(t.raw ?? null),
  }));

  const res = await db
    .insertInto('transactions')
    .values(rows)
    .onConflict((oc) =>
      oc.columns(['source', 'external_id']).doUpdateSet((eb) => ({
        amount_cents: eb.ref('excluded.amount_cents'),
        currency: eb.ref('excluded.currency'),
        raw_status: eb.ref('excluded.raw_status'),
        occurred_at: eb.ref('excluded.occurred_at'),
        raw: eb.ref('excluded.raw'),
      })),
    )
    .executeTakeFirst();

  return { written: Number(res.numInsertedOrUpdatedRows ?? 0n) };
}
