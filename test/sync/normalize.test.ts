import { describe, expect, it } from 'vitest';
import {
  googleEventToNormalized,
  hubspotToNormalized,
  stripeToNormalized,
} from '../../src/sync/adapters/normalize';

describe('normalization — three shapes, one schema', () => {
  it('maps a HubSpot contact', () => {
    const r = hubspotToNormalized({
      id: '101',
      properties: {
        firstname: 'Alice',
        lastname: 'Nguyen',
        email: 'alice@example.com',
        createdate: '2026-05-01T10:00:00Z',
        lastmodifieddate: '2026-05-20T12:00:00Z',
      },
    });
    expect(r).toMatchObject({
      source: 'hubspot',
      externalId: '101',
      recordType: 'contact',
      title: 'Alice Nguyen',
      email: 'alice@example.com',
      amountCents: null,
    });
    expect(r.sourceUpdatedAt?.toISOString()).toBe('2026-05-20T12:00:00.000Z');
  });

  it('maps a Stripe charge (amount already in integer cents; currency upper-cased)', () => {
    const r = stripeToNormalized({
      id: 'ch_1',
      object: 'charge',
      amount: 4999,
      currency: 'usd',
      status: 'succeeded',
      created: 1748773800,
      description: 'Pro plan',
      billing_details: { email: 'a@b.com' },
    });
    expect(r).toMatchObject({
      source: 'stripe',
      externalId: 'ch_1',
      recordType: 'payment',
      amountCents: 4999,
      currency: 'USD',
      status: 'succeeded',
      email: 'a@b.com',
    });
    expect(r.occurredAt).toBeInstanceOf(Date);
  });

  it('maps a Google event with a dateTime start', () => {
    const r = googleEventToNormalized({
      id: 'evt_1',
      status: 'confirmed',
      summary: 'Call',
      created: '2026-05-10T09:00:00Z',
      updated: '2026-05-11T09:00:00Z',
      start: { dateTime: '2026-06-02T15:00:00Z' },
      creator: { email: 'c@d.com' },
    });
    expect(r).toMatchObject({ source: 'google_calendar', recordType: 'event', title: 'Call' });
    expect(r.occurredAt?.toISOString()).toBe('2026-06-02T15:00:00.000Z');
  });

  it('handles an all-day Google event (date instead of dateTime)', () => {
    const r = googleEventToNormalized({
      id: 'evt_2',
      status: 'confirmed',
      summary: 'Offsite',
      start: { date: '2026-06-10' },
    });
    expect(r.occurredAt).toBeInstanceOf(Date);
  });

  it('rejects malformed records (missing/typed id) by throwing', () => {
    expect(() => hubspotToNormalized({ properties: { firstname: 'No id' } })).toThrow();
    expect(() => stripeToNormalized({ id: 'ch', amount: 'not-a-number' })).toThrow();
    expect(() => googleEventToNormalized({ summary: 'no id' })).toThrow();
  });
});
