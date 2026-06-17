import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { env } from '../src/config/env';
import { runMigrations } from '../src/shared/migrator';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'src', 'metrics', 'db', 'migrations');

const result = await runMigrations(env.DATABASE_URL_METRICS, migrationsDir);
console.log(`[migrate:metrics] applied=${result.applied.length} skipped=${result.skipped.length}`);
if (result.applied.length) console.log('  applied:', result.applied.join(', '));
