import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env';
import { healthRoutes } from './routes/health';
import { syncRoutes } from './sync/routes';
import { metricsRoutes } from './metrics/routes';

/**
 * Build the Fastify app. Exported as a factory so tests can spin up an isolated
 * instance without binding a port.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { level: env.LOG_LEVEL, transport: { target: 'pino-pretty' } }
        : { level: env.LOG_LEVEL },
    // Webhook signature verification needs the exact raw body bytes.
    bodyLimit: 5 * 1024 * 1024,
  });

  // Keep the raw JSON bytes on the request (req.rawBody) while still parsing JSON,
  // so Stripe webhook signatures can be verified against the exact payload.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = body as Buffer;
      const buf = body as Buffer;
      if (!buf || buf.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'withRemote Backend Assignment',
        description:
          'Problem 1: idempotent, fault-isolated sync pipeline (HubSpot · Stripe · Google Calendar). ' +
          'Problem 2: drift-free revenue metrics with an allow-list canonical definition.',
        version: '1.0.0',
      },
      tags: [
        { name: 'system', description: 'Health and diagnostics' },
        { name: 'sync', description: 'Problem 1 — sync pipeline' },
        { name: 'webhooks', description: 'Problem 1 — idempotent webhook receivers' },
        { name: 'metrics', description: 'Problem 2 — revenue metrics' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await app.register(healthRoutes);
  await app.register(syncRoutes);
  await app.register(metricsRoutes);

  // Friendly landing — send humans straight to the interactive docs.
  app.get('/', { schema: { hide: true } }, async (_req, reply) => reply.redirect('/docs'));

  return app;
}
