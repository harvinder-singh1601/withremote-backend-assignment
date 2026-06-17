import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const { Pool } = pg;

// Postgres returns BIGINT/NUMERIC as strings by default to avoid JS precision loss.
// We deliberately keep money as integer cents (BIGINT) and parse it ourselves where
// needed, so we leave the default string parsing in place rather than risk float drift.

/**
 * Build a typed Kysely client for a single database. Each module calls this with
 * its OWN connection string — the two clients never share a pool or a schema.
 */
export function createKysely<DB>(connectionString: string): Kysely<DB> {
  const pool = new Pool({
    connectionString,
    max: 5,
    // Supabase requires SSL; the pooler URL handles this, but be lenient on cert chain.
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
  });
}
