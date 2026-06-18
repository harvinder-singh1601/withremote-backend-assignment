/**
 * Retry transient NETWORK errors (dropped sockets, "Premature close", timeouts)
 * with exponential backoff. Deliberately does NOT retry HTTP error responses
 * (4xx/5xx) — those carry a status, and e.g. a 410 must propagate immediately so
 * the orchestrator can fall back to a full backfill rather than spin.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const e = err as { code?: string | number; status?: number; message?: string; response?: { status?: number } };

  // If it's an HTTP response error, it's not a transient socket failure.
  const status = [e.status, typeof e.code === 'number' ? e.code : undefined, e.response?.status].find(
    (v): v is number => typeof v === 'number',
  );
  if (typeof status === 'number' && status >= 400) return false;

  const msg = (e.message ?? '').toLowerCase();
  const code = typeof e.code === 'string' ? e.code : '';
  return (
    /premature close|socket hang up|other side closed|fetch failed|terminated|network|timeout|econnreset|etimedout|epipe|und_err/i.test(
      msg,
    ) || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNREFUSED'].includes(code)
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientNetworkError(err)) throw err;
      opts.onRetry?.(attempt + 1, err);
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
