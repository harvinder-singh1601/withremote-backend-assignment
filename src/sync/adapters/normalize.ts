import { z } from 'zod';
import type { NormalizedRecord } from '../domain/normalized';

// ─────────────────────────────────────────────────────────────────────────────
// Pure normalization. Each source names and shapes fields completely differently;
// these functions are the ONLY place that knowledge lives. They are pure and
// fixture-tested. A malformed item makes the relevant parse throw, and the
// orchestrator quarantines just that item.
// ─────────────────────────────────────────────────────────────────────────────

/** HubSpot CRM contact (objects v3 shape). */
const HubspotContact = z.object({
  id: z.string().min(1),
  properties: z
    .object({
      firstname: z.string().nullish(),
      lastname: z.string().nullish(),
      email: z.string().nullish(),
      createdate: z.string().nullish(),
      lastmodifieddate: z.string().nullish(),
    })
    .passthrough(),
});

export function hubspotToNormalized(rawItem: unknown): NormalizedRecord {
  const c = HubspotContact.parse(rawItem);
  const name = [c.properties.firstname, c.properties.lastname].filter(Boolean).join(' ').trim();
  return {
    source: 'hubspot',
    externalId: c.id,
    recordType: 'contact',
    title: name.length ? name : null,
    email: c.properties.email?.trim() || null,
    amountCents: null,
    currency: null,
    status: null,
    occurredAt: null,
    sourceCreatedAt: toDate(c.properties.createdate),
    sourceUpdatedAt: toDate(c.properties.lastmodifieddate),
    raw: rawItem,
  };
}

/** Stripe charge. `amount` is already in the smallest currency unit (cents);
 *  `created` is a unix timestamp in seconds. */
const StripeCharge = z.object({
  id: z.string().min(1),
  amount: z.number().int(),
  currency: z.string().min(1),
  status: z.string().min(1),
  created: z.number().int(),
  description: z.string().nullish(),
  billing_details: z.object({ email: z.string().nullish() }).passthrough().nullish(),
});

export function stripeToNormalized(rawItem: unknown): NormalizedRecord {
  const ch = StripeCharge.parse(rawItem);
  return {
    source: 'stripe',
    externalId: ch.id,
    recordType: 'payment',
    title: ch.description?.trim() || null,
    email: ch.billing_details?.email?.trim() || null,
    amountCents: ch.amount, // already integer cents
    currency: ch.currency.toUpperCase(),
    status: ch.status,
    occurredAt: new Date(ch.created * 1000),
    sourceCreatedAt: new Date(ch.created * 1000),
    sourceUpdatedAt: new Date(ch.created * 1000),
    raw: rawItem,
  };
}

/** Google Calendar event. Time can be a dateTime (timed) or date (all-day).
 *  Cancelled events arrive in incremental sync with only id + status. */
const GoogleEvent = z.object({
  id: z.string().min(1),
  status: z.string().nullish(),
  summary: z.string().nullish(),
  created: z.string().nullish(),
  updated: z.string().nullish(),
  start: z.object({ dateTime: z.string().nullish(), date: z.string().nullish() }).nullish(),
  creator: z.object({ email: z.string().nullish() }).passthrough().nullish(),
});

export function googleEventToNormalized(rawItem: unknown): NormalizedRecord {
  const e = GoogleEvent.parse(rawItem);
  const startStr = e.start?.dateTime ?? e.start?.date ?? null;
  return {
    source: 'google_calendar',
    externalId: e.id,
    recordType: 'event',
    title: e.summary?.trim() || null,
    email: e.creator?.email?.trim() || null,
    amountCents: null,
    currency: null,
    status: e.status ?? null,
    occurredAt: toDate(startStr),
    sourceCreatedAt: toDate(e.created),
    sourceUpdatedAt: toDate(e.updated),
    raw: rawItem,
  };
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
