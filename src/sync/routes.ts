import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { syncDb } from './db/client';
import { getRegistry } from './registry';
import { runSync } from './orchestrator';
import { handleHubspotWebhook, handleStripeWebhook } from './webhooks';
import { SourceName } from './domain/normalized';
import { withSimulatedFailure, type FailureKind } from './adapters/simulate';

const SOURCE_ENUM = ['all', 'hubspot', 'stripe', 'google_calendar'] as const;
const SIMULATE_ENUM = ['stale', 'down', 'garbage'] as const;

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // ── Trigger a sync run (the "trigger a real running job" deliverable) ───────
  app.post<{
    Querystring: {
      source?: (typeof SOURCE_ENUM)[number];
      simulate?: (typeof SIMULATE_ENUM)[number];
      simulateOn?: (typeof SOURCE_ENUM)[number];
    };
  }>(
    '/sync/run',
    {
      schema: {
        tags: ['sync'],
        summary: 'Run a sync for all sources (or one). Idempotent and fault-isolated.',
        description:
          'Optionally inject a failure for this run to demo resilience:\n' +
          '- `simulate=stale` → incremental cursor rejected → full backfill\n' +
          '- `simulate=down` → source isolated, the others still land\n' +
          '- `simulate=garbage` → bad record quarantined, the rest land\n' +
          'Scope it with `simulateOn` (default: the source being run).',
        querystring: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: [...SOURCE_ENUM], default: 'all' },
            simulate: { type: 'string', enum: [...SIMULATE_ENUM] },
            simulateOn: { type: 'string', enum: [...SOURCE_ENUM] },
          },
        },
      },
    },
    async (req) => {
      const only = req.query.source ?? 'all';
      const { sources } = getRegistry();

      // Optionally wrap one (or all) sources to inject a failure for this run only.
      let effective = sources;
      if (req.query.simulate) {
        const kind = req.query.simulate as FailureKind;
        const target = req.query.simulateOn ?? only;
        effective = sources.map((s) =>
          target === 'all' || s.name === target ? withSimulatedFailure(s, kind) : s,
        );
      }

      const runs = await runSync(syncDb, effective, only === 'all' ? 'all' : only, app.log);
      return { ok: true, simulated: req.query.simulate ?? null, runs };
    },
  );

  // ── Inspect cursors + per-source health + recent runs ───────────────────────
  app.get(
    '/sync/state',
    {
      schema: {
        tags: ['sync'],
        summary: 'Per-source cursor, health, live/fixture mode, and recent runs',
      },
    },
    async () => {
      const { modes } = getRegistry();
      const states = await syncDb.selectFrom('sync_state').selectAll().execute();
      const recentRuns = await syncDb
        .selectFrom('sync_runs')
        .selectAll()
        .orderBy('started_at', 'desc')
        .limit(15)
        .execute();
      return {
        sources: states.map((s) => ({ ...s, mode: modes[s.source as keyof typeof modes] ?? null })),
        modes,
        recentRuns,
      };
    },
  );

  // ── Inspect normalized records ──────────────────────────────────────────────
  app.get<{ Querystring: { source?: string; type?: string; limit?: number } }>(
    '/records',
    {
      schema: {
        tags: ['sync'],
        summary: 'List normalized records across all sources',
        querystring: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: SourceName.options },
            type: { type: 'string', enum: ['contact', 'payment', 'event'] },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
        },
      },
    },
    async (req) => {
      let q = syncDb.selectFrom('records').selectAll().orderBy('synced_at', 'desc');
      if (req.query.source) q = q.where('source', '=', req.query.source);
      if (req.query.type) q = q.where('record_type', '=', req.query.type);
      const rows = await q.limit(req.query.limit ?? 50).execute();
      const total = await syncDb
        .selectFrom('records')
        .select(sql<string>`count(*)`.as('c'))
        .executeTakeFirstOrThrow();
      return { total: Number(total.c), count: rows.length, records: rows };
    },
  );

  // ── Webhooks (idempotent receivers) ─────────────────────────────────────────
  app.post(
    '/webhooks/stripe',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Stripe webhook — idempotent. Firing the same event twice is a no-op.',
      },
    },
    async (req: FastifyRequest, reply) => {
      const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
      const signature = req.headers['stripe-signature'] as string | undefined;
      try {
        return await handleStripeWebhook(syncDb, rawBody, signature);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, 'stripe webhook rejected');
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    '/webhooks/hubspot',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'HubSpot webhook — hydrates + upserts contacts idempotently',
      },
    },
    async (req) => handleHubspotWebhook(syncDb, req.body),
  );
}
