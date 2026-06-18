import { describe, expect, it } from 'vitest';
import { isTransientNetworkError, withRetry } from '../../src/sync/adapters/retry';

describe('isTransientNetworkError', () => {
  it('treats dropped-socket errors as transient', () => {
    expect(isTransientNetworkError(new Error('Invalid response body ...: Premature close'))).toBe(true);
    expect(isTransientNetworkError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('does NOT treat HTTP error responses as transient (so 410 propagates)', () => {
    expect(isTransientNetworkError({ code: 410, message: 'Gone' })).toBe(false);
    expect(isTransientNetworkError({ response: { status: 410 } })).toBe(false);
    expect(isTransientNetworkError({ status: 401 })).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('Premature close');
        return 'ok';
      },
      { baseMs: 1 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not retry a non-transient error (fails fast)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { code: 410, message: 'Gone' };
        },
        { baseMs: 1 },
      ),
    ).rejects.toMatchObject({ code: 410 });
    expect(calls).toBe(1);
  });
});
