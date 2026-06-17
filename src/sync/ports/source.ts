import type { NormalizedRecord, SourceName } from '../domain/normalized';

export type CursorType = 'timestamp' | 'sync_token' | 'object_id';

export interface FetchResult {
  /** Raw, source-shaped records — NOT yet normalized or validated. */
  raw: unknown[];
  /** Cursor to persist for the next incremental fetch (null if none available). */
  nextCursor: string | null;
}

/**
 * One port, three adapters. The orchestrator only ever talks to this interface,
 * so it has no idea whether it's driving HubSpot, Stripe, Google, or a fixture.
 */
export interface DataSource {
  readonly name: SourceName;
  readonly cursorType: CursorType;

  /**
   * Fetch "what changed since `cursor`". MUST throw {@link StaleCursorError} when
   * the source rejects the cursor (e.g. Google 410, expired token) so the
   * orchestrator can fall back to a full backfill instead of losing data.
   */
  fetchIncremental(cursor: string): Promise<FetchResult>;

  /** Fetch everything. Used for the first sync and as the staleness fallback. */
  fetchFull(): Promise<FetchResult>;

  /** Map ONE raw item to the normalized shape. May throw on a malformed item;
   *  the orchestrator quarantines those per-record rather than failing the run. */
  toNormalized(rawItem: unknown): NormalizedRecord;
}

/**
 * Thrown by an adapter when an incremental cursor is stale/expired/rejected.
 * This is the signal that triggers the full-backfill fallback.
 */
export class StaleCursorError extends Error {
  constructor(
    public readonly source: SourceName,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StaleCursorError';
  }
}
