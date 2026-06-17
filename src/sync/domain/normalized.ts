import { z } from 'zod';

/** The three sources, named once. */
export const SourceName = z.enum(['hubspot', 'stripe', 'google_calendar']);
export type SourceName = z.infer<typeof SourceName>;

export const RecordType = z.enum(['contact', 'payment', 'event']);
export type RecordType = z.infer<typeof RecordType>;

/**
 * The single normalized shape every source maps into. Each source names and
 * shapes its fields differently; this is the one schema they all land in.
 *
 * `externalId` + `source` is the natural key that makes writes idempotent.
 */
export const NormalizedRecord = z.object({
  source: SourceName,
  externalId: z.string().min(1),
  recordType: RecordType,
  title: z.string().nullable(),
  email: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  status: z.string().nullable(),
  occurredAt: z.date().nullable(),
  sourceCreatedAt: z.date().nullable(),
  sourceUpdatedAt: z.date().nullable(),
  raw: z.unknown(),
});

export type NormalizedRecord = z.infer<typeof NormalizedRecord>;
