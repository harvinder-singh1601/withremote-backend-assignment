import { describe, expect, it } from 'vitest';
import { classify, collectingPairs, isCollected } from '../../src/metrics/statusMap';

describe('status allow-list', () => {
  it('classifies known collecting statuses across vocabularies', () => {
    expect(classify('stripe', 'succeeded')).toBe('collected');
    expect(classify('quickbooks', 'paid')).toBe('collected');
    expect(classify('square', 'completed')).toBe('collected');
  });

  it('classifies known non-collecting statuses', () => {
    expect(classify('stripe', 'refunded')).toBe('not_collected');
    expect(classify('quickbooks', 'voided')).toBe('not_collected');
    expect(classify('square', 'failed')).toBe('not_collected');
  });

  it('treats UNKNOWN statuses as not-collected (allow-list, not exclusion list)', () => {
    // A brand-new status a source might introduce must NOT silently become revenue.
    expect(classify('stripe', 'disputed')).toBe('unknown');
    expect(classify('stripe', 'chargeback')).toBe('unknown');
    expect(isCollected('stripe', 'disputed')).toBe(false);
    expect(classify('newsource', 'paid')).toBe('unknown');
  });

  it('collectingPairs contains only collected statuses', () => {
    const pairs = collectingPairs();
    expect(pairs).toContainEqual({ source: 'stripe', status: 'succeeded' });
    expect(pairs).toContainEqual({ source: 'quickbooks', status: 'paid' });
    expect(pairs).toContainEqual({ source: 'square', status: 'completed' });
    expect(pairs.every((p) => classify(p.source, p.status) === 'collected')).toBe(true);
  });
});
