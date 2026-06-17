import type { NormalizedRecord } from '../domain/normalized';
import { StaleCursorError, type DataSource } from '../ports/source';

export type FailureKind = 'stale' | 'down' | 'garbage';

/**
 * Wrap a source to inject a failure for ONE run — used to demo the resilience
 * requirements deterministically (no waiting for a real Google token to expire):
 *
 *  - 'stale':   incremental throws StaleCursorError → orchestrator full-backfills
 *  - 'down':    every fetch throws → source is isolated, siblings still land
 *  - 'garbage': prepends a malformed record → it's quarantined, the rest land
 */
export function withSimulatedFailure(source: DataSource, kind: FailureKind): DataSource {
  return {
    name: source.name,
    cursorType: source.cursorType,
    toNormalized: (item: unknown): NormalizedRecord => source.toNormalized(item),
    async fetchFull() {
      if (kind === 'down') throw new Error(`${source.name} is down (simulated)`);
      const res = await source.fetchFull();
      if (kind === 'garbage') return { ...res, raw: [{ totally: 'malformed' }, ...res.raw] };
      return res;
    },
    async fetchIncremental(cursor: string) {
      if (kind === 'down') throw new Error(`${source.name} is down (simulated)`);
      if (kind === 'stale') {
        throw new StaleCursorError(source.name, 'simulated stale cursor (HTTP 410)');
      }
      const res = await source.fetchIncremental(cursor);
      if (kind === 'garbage') return { ...res, raw: [{ totally: 'malformed' }, ...res.raw] };
      return res;
    },
  };
}
