import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { env } from '../src/config/env';
import { runMigrations } from '../src/shared/migrator';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'src', 'sync', 'db', 'migrations');

const result = await runMigrations(env.DATABASE_URL_SYNC, migrationsDir);
console.log(`[migrate:sync] applied=${result.applied.length} skipped=${result.skipped.length}`);
if (result.applied.length) console.log('  applied:', result.applied.join(', '));
