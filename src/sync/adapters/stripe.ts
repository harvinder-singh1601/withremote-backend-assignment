import Stripe from 'stripe';
import { env } from '../../config/env';
import type { NormalizedRecord } from '../domain/normalized';
import type { CursorType, DataSource, FetchResult } from '../ports/source';
import { stripeToNormalized } from './normalize';

export function hasStripeCredential(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/**
 * Live Stripe payments source. Incremental fetch uses a `created` timestamp
 * cursor (`created[gt]`), which is monotonic and replay-safe — re-fetching the
 * same window just re-upserts identical rows (a no-op thanks to the content hash).
 */
export class StripeSource implements DataSource {
  readonly name = 'stripe' as const;
  readonly cursorType: CursorType = 'timestamp';
  private readonly client: Stripe;

  constructor(secretKey: string) {
    this.client = new Stripe(secretKey);
  }

  toNormalized(rawItem: unknown): NormalizedRecord {
    return stripeToNormalized(rawItem);
  }

  async fetchFull(): Promise<FetchResult> {
    const charges = await this.client.charges
      .list({ limit: 100 })
      .autoPagingToArray({ limit: 10000 });
    return { raw: charges, nextCursor: this.maxCreated(charges) };
  }

  async fetchIncremental(cursor: string): Promise<FetchResult> {
    const since = Number.parseInt(cursor, 10);
    const charges = await this.client.charges
      .list({ limit: 100, created: { gt: Number.isFinite(since) ? since : 0 } })
      .autoPagingToArray({ limit: 10000 });
    // If nothing changed, keep the existing cursor so we don't rewind.
    return { raw: charges, nextCursor: this.maxCreated(charges) ?? cursor };
  }

  private maxCreated(charges: Stripe.Charge[]): string | null {
    if (charges.length === 0) return null;
    return String(Math.max(...charges.map((c) => c.created)));
  }
}
