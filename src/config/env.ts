import { z } from 'zod';

// Load .env if present (no-op in production where vars are set directly).
// process.loadEnvFile is built into Node >= 20.12 — no dotenv dependency needed.
try {
  process.loadEnvFile();
} catch {
  // .env not present (e.g. production / CI) — env comes from the environment.
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Two separate databases — one per module.
  DATABASE_URL_SYNC: z.string().min(1).default('postgres://postgres:postgres@localhost:5433/sync'),
  DATABASE_URL_METRICS: z
    .string()
    .min(1)
    .default('postgres://postgres:postgres@localhost:5434/metrics'),

  // Source credentials are OPTIONAL: an adapter without its key serves recorded
  // fixtures instead, so the service always boots and the demo always runs.
  HUBSPOT_PRIVATE_APP_TOKEN: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),

  SOURCE_MODE: z.enum(['auto', 'live', 'fixture']).default('auto'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable message rather than crashing deep in a handler.
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

/**
 * Resolve whether a source should run live or from fixtures.
 * - SOURCE_MODE=live    -> always live (errors if key missing)
 * - SOURCE_MODE=fixture -> always fixtures
 * - SOURCE_MODE=auto    -> live when the credential is present, else fixtures
 */
export function resolveMode(hasCredential: boolean): 'live' | 'fixture' {
  if (env.SOURCE_MODE === 'live') return 'live';
  if (env.SOURCE_MODE === 'fixture') return 'fixture';
  return hasCredential ? 'live' : 'fixture';
}
