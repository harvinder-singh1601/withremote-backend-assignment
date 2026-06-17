import { env } from '../../config/env';
import { createKysely } from '../../shared/kysely';
import type { MetricsDB } from './types';

/** Kysely client for Problem 2's database (Supabase project B). */
export const metricsDb = createKysely<MetricsDB>(env.DATABASE_URL_METRICS);
