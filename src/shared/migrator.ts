import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

/**
 * Minimal, transparent SQL migration runner.
 *
 * Applies every `*.sql` file in `migrationsDir` in lexical order, each inside its
 * own transaction, and records applied files in a `_migrations` table so re-runs
 * are no-ops. Deliberately tiny and dependency-light — easy to read and reason
 * about for a take-home, and each migration is plain reviewable SQL.
 */
export async function runMigrations(
  connectionString: string,
  migrationsDir: string,
): Promise<{ applied: string[]; skipped: string[] }> {
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name        text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    const { rows } = await pool.query<{ name: string }>('SELECT name FROM _migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  return { applied, skipped };
}
