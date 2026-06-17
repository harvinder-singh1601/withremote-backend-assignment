import { Client } from '@hubspot/api-client';
import { env } from '../../config/env';
import type { NormalizedRecord } from '../domain/normalized';
import { StaleCursorError, type CursorType, type DataSource, type FetchResult } from '../ports/source';
import { hubspotToNormalized } from './normalize';

const PROPS = ['firstname', 'lastname', 'email', 'createdate', 'lastmodifieddate'];

export function hasHubspotCredential(): boolean {
  return Boolean(env.HUBSPOT_PRIVATE_APP_TOKEN);
}

/**
 * Live HubSpot CRM contacts source. Full = paged list; incremental = Search API
 * filtered on `lastmodifieddate > cursor` (cursor is epoch-ms). HubSpot's search
 * pagination caps at a 10k window — when a deep cursor blows past it, that's our
 * stale-cursor signal and we fall back to a full backfill.
 */
export class HubspotSource implements DataSource {
  readonly name = 'hubspot' as const;
  readonly cursorType: CursorType = 'timestamp';
  private readonly client: Client;

  constructor(accessToken: string) {
    this.client = new Client({ accessToken });
  }

  toNormalized(rawItem: unknown): NormalizedRecord {
    return hubspotToNormalized(rawItem);
  }

  async fetchFull(): Promise<FetchResult> {
    const raw: unknown[] = [];
    let after: string | undefined;
    do {
      const page = await this.client.crm.contacts.basicApi.getPage(100, after, PROPS);
      raw.push(...page.results);
      after = page.paging?.next?.after;
    } while (after);
    return { raw, nextCursor: this.maxModified(raw) };
  }

  async fetchIncremental(cursor: string): Promise<FetchResult> {
    const raw: unknown[] = [];
    let after: string | undefined;
    try {
      do {
        const body = {
          filterGroups: [
            { filters: [{ propertyName: 'lastmodifieddate', operator: 'GT', value: cursor }] },
          ],
          sorts: ['lastmodifieddate'],
          properties: PROPS,
          limit: 100,
          after,
          // The operator field is a generated enum; a string literal is correct at
          // runtime. Cast is localized to keep the call typed without importing the
          // deep codegen enum path.
        } as unknown as Parameters<typeof this.client.crm.contacts.searchApi.doSearch>[0];

        const page = await this.client.crm.contacts.searchApi.doSearch(body);
        raw.push(...page.results);
        after = page.paging?.next?.after;
      } while (after);
    } catch (err) {
      // Deep search pagination / window-exceeded → treat as stale and full-backfill.
      const status = (err as { code?: number }).code;
      if (status === 400 || status === 416) {
        throw new StaleCursorError(this.name, `HubSpot search cursor rejected (${status})`, err);
      }
      throw err;
    }
    return { raw, nextCursor: this.maxModified(raw) ?? cursor };
  }

  /** Fetch one contact by id (used by the webhook receiver to hydrate full props). */
  async fetchById(id: string): Promise<unknown> {
    return this.client.crm.contacts.basicApi.getById(id, PROPS);
  }

  private maxModified(items: unknown[]): string | null {
    let max = 0;
    for (const it of items) {
      const v = (it as { properties?: { lastmodifieddate?: string } }).properties?.lastmodifieddate;
      const t = v ? Date.parse(v) : NaN;
      if (Number.isFinite(t) && t > max) max = t;
    }
    return max > 0 ? String(max) : null;
  }
}
