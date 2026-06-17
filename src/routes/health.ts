import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { syncDb } from '../sync/db/client';
import { metricsDb } from '../metrics/db/client';

/** Liveness + readiness. Pings both databases independently so a single DB outage
 *  is reported precisely rather than as a generic 500. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness and per-database readiness',
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              databases: {
                type: 'object',
                properties: {
                  sync: { type: 'string' },
                  metrics: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const check = async (db: typeof syncDb | typeof metricsDb): Promise<string> => {
        try {
          await sql`SELECT 1`.execute(db);
          return 'up';
        } catch {
          return 'down';
        }
      };
      const [syncStatus, metricsStatus] = await Promise.all([check(syncDb), check(metricsDb)]);
      return {
        status: 'ok',
        databases: { sync: syncStatus, metrics: metricsStatus },
      };
    },
  );
}
