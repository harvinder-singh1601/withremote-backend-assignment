import { env } from '../../config/env';
import { createKysely } from '../../shared/kysely';
import type { SyncDB } from './types';

/** Kysely client for Problem 1's database (Supabase project A). */
export const syncDb = createKysely<SyncDB>(env.DATABASE_URL_SYNC);
