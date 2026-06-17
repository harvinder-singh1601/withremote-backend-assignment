import { runSync } from '../src/sync/orchestrator';
import { getRegistry } from '../src/sync/registry';
import { syncDb } from '../src/sync/db/client';
import { seedTransactions } from '../src/metrics/seed';
import { metricsDb } from '../src/metrics/db/client';

// Problem 1: land normalized records by running a sync across all sources.
const { sources } = getRegistry();
const runs = await runSync(syncDb, sources);
console.log('[seed] sync:', runs.map((r) => `${r.source}:${r.mode}:+${r.upserted}`).join('  '));

// Problem 2: seed transactions (Stripe test + simulated sources).
const metrics = await seedTransactions(metricsDb);
console.log('[seed] metrics:', JSON.stringify(metrics));

await syncDb.destroy();
await metricsDb.destroy();
