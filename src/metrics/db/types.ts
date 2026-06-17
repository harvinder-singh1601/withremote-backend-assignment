import type { ColumnType, Generated, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Money is stored as integer cents (BIGINT) to eliminate float drift. */
type BigIntCol = ColumnType<string, number, number>;
type Jsonb = ColumnType<unknown, string, string>;

export interface TransactionsTable {
  id: Generated<string>;
  source: string;
  external_id: string;
  amount_cents: BigIntCol;
  currency: string;
  raw_status: string;
  occurred_at: Timestamp;
  raw: Jsonb;
  ingested_at: Generated<Timestamp>;
}

export interface MetricsDB {
  transactions: TransactionsTable;
}

export type TransactionRow = Selectable<TransactionsTable>;
