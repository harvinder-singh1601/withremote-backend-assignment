import { env, resolveMode } from '../config/env';
import type { SourceName } from './domain/normalized';
import type { DataSource } from './ports/source';
import { buildFixtureSources } from './adapters/fixtures';
import { HubspotSource, hasHubspotCredential } from './adapters/hubspot';
import { StripeSource, hasStripeCredential } from './adapters/stripe';
import { GoogleCalendarSource, hasGoogleCredential } from './adapters/googleCalendar';

export interface SourceRegistry {
  sources: DataSource[];
  modes: Record<SourceName, 'live' | 'fixture'>;
}

function pick(
  name: SourceName,
  hasCred: boolean,
  makeLive: () => DataSource,
  fixture: DataSource,
): { source: DataSource; mode: 'live' | 'fixture' } {
  const mode = resolveMode(hasCred);
  if (mode === 'live') {
    if (!hasCred) {
      throw new Error(`SOURCE_MODE=live but '${name}' has no credentials configured`);
    }
    return { source: makeLive(), mode };
  }
  return { source: fixture, mode };
}

/**
 * Compose the three sources. Each is live when its credential is present (or when
 * SOURCE_MODE=live), otherwise it serves recorded fixtures — so the pipeline runs
 * end to end regardless of which accounts are wired up.
 */
export function buildRegistry(): SourceRegistry {
  const fixtures = new Map(buildFixtureSources().map((s) => [s.name, s] as const));

  const hubspot = pick(
    'hubspot',
    hasHubspotCredential(),
    () => new HubspotSource(env.HUBSPOT_PRIVATE_APP_TOKEN!),
    fixtures.get('hubspot')!,
  );
  const stripe = pick(
    'stripe',
    hasStripeCredential(),
    () => new StripeSource(env.STRIPE_SECRET_KEY!),
    fixtures.get('stripe')!,
  );
  const google = pick(
    'google_calendar',
    hasGoogleCredential(),
    () => new GoogleCalendarSource(),
    fixtures.get('google_calendar')!,
  );

  return {
    sources: [hubspot.source, stripe.source, google.source],
    modes: {
      hubspot: hubspot.mode,
      stripe: stripe.mode,
      google_calendar: google.mode,
    },
  };
}

let cached: SourceRegistry | undefined;
export function getRegistry(): SourceRegistry {
  if (!cached) cached = buildRegistry();
  return cached;
}
