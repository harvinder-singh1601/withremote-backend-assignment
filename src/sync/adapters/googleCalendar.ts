import https from 'node:https';
import { env } from '../../config/env';
import type { NormalizedRecord } from '../domain/normalized';
import { StaleCursorError, type CursorType, type DataSource, type FetchResult } from '../ports/source';
import { googleEventToNormalized } from './normalize';
import { withRetry } from './retry';

export function hasGoogleCredential(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

interface HttpsResult {
  status: number;
  json: Record<string, unknown> | null;
  raw: string;
}

/**
 * Minimal HTTPS JSON request via Node's `https` module — deliberately NOT the
 * global fetch/undici, which on Render consistently failed Google calls with
 * "Premature close". We also don't request compression, so the response is plain
 * JSON (no br/gzip decode step to choke on).
 */
function httpsJson(options: https.RequestOptions, body?: string): Promise<HttpsResult> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: Record<string, unknown> | null = null;
        try {
          json = data ? (JSON.parse(data) as Record<string, unknown>) : null;
        } catch {
          /* leave json null; caller inspects status/raw */
        }
        resolve({ status: res.statusCode ?? 0, json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Google request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Live Google Calendar events source — the canonical stale-cursor case.
 *
 * Incremental fetch uses Google's `syncToken`. When that token is expired,
 * `events.list` returns HTTP 410 Gone; we surface that as StaleCursorError so the
 * orchestrator full-backfills and mints a fresh token. Transient socket failures
 * are retried; a 410 is not (it must propagate to trigger the fallback).
 */
export class GoogleCalendarSource implements DataSource {
  readonly name = 'google_calendar' as const;
  readonly cursorType: CursorType = 'sync_token';
  private readonly calendarId: string;

  constructor() {
    this.calendarId = env.GOOGLE_CALENDAR_ID;
  }

  toNormalized(rawItem: unknown): NormalizedRecord {
    return googleEventToNormalized(rawItem);
  }

  /** Exchange the refresh token for a short-lived access token. */
  private async accessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }).toString();

    const res = await withRetry(() =>
      httpsJson(
        {
          method: 'POST',
          hostname: 'oauth2.googleapis.com',
          path: '/token',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
            accept: 'application/json',
          },
        },
        body,
      ),
    );
    const token = res.json?.access_token;
    if (res.status !== 200 || typeof token !== 'string') {
      throw new Error(`Google token exchange failed (${res.status}): ${res.raw.slice(0, 200)}`);
    }
    return token;
  }

  async fetchFull(): Promise<FetchResult> {
    return this.drain({ singleEvents: 'true', showDeleted: 'true' });
  }

  async fetchIncremental(cursor: string): Promise<FetchResult> {
    return this.drain({ syncToken: cursor, showDeleted: 'true' });
  }

  /** Page through events.list, accumulating items and capturing nextSyncToken. */
  private async drain(params: Record<string, string>): Promise<FetchResult> {
    const token = await this.accessToken();
    const raw: unknown[] = [];
    let pageToken: string | undefined;
    let syncToken: string | null = null;

    do {
      const qs = new URLSearchParams({
        maxResults: '250',
        ...params,
        ...(pageToken ? { pageToken } : {}),
      }).toString();

      const res = await withRetry(() =>
        httpsJson({
          method: 'GET',
          hostname: 'www.googleapis.com',
          path: `/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?${qs}`,
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        }),
      );

      if (res.status === 410) {
        throw new StaleCursorError(this.name, 'Google syncToken expired (HTTP 410)');
      }
      if (res.status !== 200 || !res.json) {
        throw new Error(`Google events.list failed (${res.status}): ${res.raw.slice(0, 200)}`);
      }

      raw.push(...((res.json.items as unknown[]) ?? []));
      pageToken = (res.json.nextPageToken as string | undefined) ?? undefined;
      syncToken = (res.json.nextSyncToken as string | undefined) ?? syncToken;
    } while (pageToken);

    return { raw, nextCursor: syncToken };
  }
}
