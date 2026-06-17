import Stripe from 'stripe';
import type { Kysely } from 'kysely';
import { env } from '../config/env';
import type { SyncDB } from './db/types';
import { stripeToNormalized, hubspotToNormalized } from './adapters/normalize';
import { HubspotSource, hasHubspotCredential } from './adapters/hubspot';
import { upsertRecords } from './repository';

export interface WebhookResult {
  received: boolean;
  type?: string;
  written: number;
  note?: string;
}

/**
 * Stripe webhook. Verifies the signature when a signing secret is configured;
 * in local/demo mode (no secret) it parses the event unverified so the
 * fire-it-twice idempotency demo works offline. Either way it routes through the
 * SAME idempotent upsert as the batch sync — a duplicate delivery is a no-op.
 */
export async function handleStripeWebhook(
  db: Kysely<SyncDB>,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<WebhookResult> {
  let event: Stripe.Event;

  if (env.STRIPE_WEBHOOK_SECRET && env.STRIPE_SECRET_KEY) {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, signature ?? '', env.STRIPE_WEBHOOK_SECRET);
  } else {
    event = JSON.parse(rawBody.toString('utf8')) as Stripe.Event;
  }

  const obj = event.data?.object as { object?: string } | undefined;
  if (obj?.object === 'charge') {
    const { written } = await upsertRecords(db, [stripeToNormalized(obj)]);
    return { received: true, type: event.type, written };
  }
  return { received: true, type: event.type, written: 0, note: `ignored object '${obj?.object}'` };
}

/**
 * HubSpot webhook. Payloads carry only objectId + change metadata, so we hydrate
 * each contact via the API and upsert it idempotently. No-ops gracefully when no
 * HubSpot credential is configured.
 */
export async function handleHubspotWebhook(
  db: Kysely<SyncDB>,
  body: unknown,
): Promise<WebhookResult> {
  const events = Array.isArray(body) ? body : [];
  if (!hasHubspotCredential()) {
    return { received: true, written: 0, note: 'no HubSpot credential; cannot hydrate contacts' };
  }

  const source = new HubspotSource(env.HUBSPOT_PRIVATE_APP_TOKEN!);
  const records = [];
  for (const ev of events) {
    const objectId = (ev as { objectId?: number | string }).objectId;
    if (objectId == null) continue;
    try {
      records.push(hubspotToNormalized(await source.fetchById(String(objectId))));
    } catch {
      // contact deleted / not found — skip, don't fail the whole delivery
    }
  }
  const { written } = await upsertRecords(db, records);
  return { received: true, written };
}
