/**
 * The canonical "is this money actually collected?" authority.
 *
 * This is an ALLOW-LIST, on purpose. Every status each source can emit is listed
 * explicitly and mapped to `collected` or `not_collected`. A status we've never
 * seen classifies as `unknown` → it does NOT count as revenue, and a completeness
 * test fails until someone consciously classifies it.
 *
 * The opposite design — an exclusion list ("everything counts except refunded/
 * failed") — silently lets a brand-new status (say `disputed` or `chargeback`)
 * count as revenue the moment a source introduces it. That's the drift we refuse.
 */
export type Classification = 'collected' | 'not_collected';

export const STATUS_MAP: Record<string, Record<string, Classification>> = {
  stripe: {
    succeeded: 'collected',
    pending: 'not_collected',
    failed: 'not_collected',
    refunded: 'not_collected',
  },
  quickbooks: {
    paid: 'collected',
    pending: 'not_collected',
    voided: 'not_collected',
  },
  square: {
    completed: 'collected',
    failed: 'not_collected',
    refunded: 'not_collected',
  },
};

/** Classify a (source, status) pair. Unknown pairs are NOT collected. */
export function classify(source: string, rawStatus: string): Classification | 'unknown' {
  return STATUS_MAP[source]?.[rawStatus] ?? 'unknown';
}

export function isCollected(source: string, rawStatus: string): boolean {
  return classify(source, rawStatus) === 'collected';
}

export function isKnown(source: string, rawStatus: string): boolean {
  return classify(source, rawStatus) !== 'unknown';
}

export interface SourceStatus {
  source: string;
  status: string;
}

/** Every (source, status) pair that counts as collected — drives the SQL filter. */
export function collectingPairs(): SourceStatus[] {
  const pairs: SourceStatus[] = [];
  for (const [source, statuses] of Object.entries(STATUS_MAP)) {
    for (const [status, cls] of Object.entries(statuses)) {
      if (cls === 'collected') pairs.push({ source, status });
    }
  }
  return pairs;
}
