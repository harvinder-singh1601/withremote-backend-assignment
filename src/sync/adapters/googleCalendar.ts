import { google, type calendar_v3 } from 'googleapis';
import { env } from '../../config/env';
import type { NormalizedRecord } from '../domain/normalized';
import { StaleCursorError, type CursorType, type DataSource, type FetchResult } from '../ports/source';
import { googleEventToNormalized } from './normalize';

export function hasGoogleCredential(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/**
 * Live Google Calendar events source — the canonical stale-cursor case.
 *
 * Incremental fetch uses Google's `syncToken`. When that token is expired or
 * invalidated, `events.list` returns HTTP 410 Gone; Google's documented recovery
 * is exactly "discard the token and do a full sync." We surface that 410 as a
 * StaleCursorError so the orchestrator full-backfills and mints a fresh token.
 */
export class GoogleCalendarSource implements DataSource {
  readonly name = 'google_calendar' as const;
  readonly cursorType: CursorType = 'sync_token';
  private readonly calendar: calendar_v3.Calendar;
  private readonly calendarId: string;

  constructor() {
    const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
    this.calendar = google.calendar({ version: 'v3', auth: oauth2 });
    this.calendarId = env.GOOGLE_CALENDAR_ID;
  }

  toNormalized(rawItem: unknown): NormalizedRecord {
    return googleEventToNormalized(rawItem);
  }

  async fetchFull(): Promise<FetchResult> {
    return this.drain({ singleEvents: true, showDeleted: true });
  }

  async fetchIncremental(cursor: string): Promise<FetchResult> {
    try {
      return await this.drain({ syncToken: cursor, showDeleted: true });
    } catch (err) {
      if (this.isGone(err)) {
        throw new StaleCursorError(this.name, 'Google syncToken expired (HTTP 410)', err);
      }
      throw err;
    }
  }

  /** Page through events.list, accumulating items and capturing nextSyncToken. */
  private async drain(params: calendar_v3.Params$Resource$Events$List): Promise<FetchResult> {
    const raw: unknown[] = [];
    let pageToken: string | undefined;
    let syncToken: string | null | undefined;
    do {
      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        maxResults: 250,
        ...params,
        pageToken,
      });
      raw.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
      syncToken = res.data.nextSyncToken ?? syncToken;
    } while (pageToken);
    return { raw, nextCursor: syncToken ?? null };
  }

  private isGone(err: unknown): boolean {
    const e = err as { code?: number; status?: number; response?: { status?: number } };
    return e.code === 410 || e.status === 410 || e.response?.status === 410;
  }
}
