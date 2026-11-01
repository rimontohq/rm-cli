import { describe, expect, it } from 'vitest';
import { NetworkError } from '../src/errors.ts';
import { MAX_RETRIES, retryAfter, send, type HttpRequest } from '../src/http.ts';
import { fakeFetch, json, problem, refused, reset, type Handler } from './helpers.ts';

function call(req: Partial<HttpRequest>, handler: Handler) {
  const { fetch, requests } = fakeFetch(handler);
  const sleeps: number[] = [];
  const promise = send(
    { method: 'POST', url: 'https://api.test/tickets', headers: {}, retry: false, ...req },
    { fetch, sleep: async (ms) => void sleeps.push(ms), timeoutMs: 1000, random: () => 0, now: () => Date.parse('2026-11-01T12:00:00Z') },
  );
  return { promise, requests, sleeps };
}

const keyed = { retry: true, idempotencyKey: 'k-1', headers: { 'idempotency-key': 'k-1' } };

describe('retries', () => {
  it('retries a command with an Idempotency-Key after a 503, with the same key', async () => {
    const { promise, requests, sleeps } = call(keyed, (_, n) => (n < 3 ? problem(503, 'retry', 'Try again') : json(201, { ok: true })));
    const res = await promise;
    expect(res.status).toBe(201);
    expect(res.attempts).toBe(3);
    expect(requests.map((r) => r.headers['idempotency-key'])).toEqual(['k-1', 'k-1', 'k-1']);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('waits as Retry-After says, in seconds or as a date', async () => {
    const { promise, sleeps } = call(keyed, (_, n) => (n === 1 ? problem(429, 'slow-down', 'Too many') : json(200, {})));
    await promise;
    expect(sleeps).toEqual([500]);
    const withHeader = call(keyed, (_, n) => (n === 1 ? new Response('', { status: 503, headers: { 'retry-after': '2' } }) : json(200, {})));
    await withHeader.promise;
    expect(withHeader.sleeps).toEqual([2000]);
    expect(retryAfter('Sun, 01 Nov 2026 12:00:05 GMT', Date.parse('2026-11-01T12:00:00Z'))).toBe(5000);
  });

  it('does not wait for a long Retry-After: the error is the answer', async () => {
    const { promise, requests } = call(keyed, () => new Response('', { status: 429, headers: { 'retry-after': '900' } }));
    expect((await promise).status).toBe(429);
    expect(requests).toHaveLength(1);
  });

  it('gives up after MAX_RETRIES retries and returns the last answer', async () => {
    const { promise, requests } = call(keyed, () => problem(500, 'internal', 'Something went wrong'));
    expect((await promise).status).toBe(500);
    expect(requests).toHaveLength(MAX_RETRIES + 1);
  });

  it('never retries a 501, nor a 4xx', async () => {
    expect((await call(keyed, () => problem(501, 'nope', 'Not implemented')).promise).attempts).toBe(1);
    expect((await call(keyed, () => problem(409, 'no-open-shift', 'No open shift')).promise).attempts).toBe(1);
  });

  it('sends a command without a key once, even after a 500 or a lost connection', async () => {
    const res = call({ retry: false }, () => problem(500, 'internal', 'Something went wrong'));
    expect((await res.promise).attempts).toBe(1);
    const lost = call({ retry: false }, () => reset());
    await expect(lost.promise).rejects.toBeInstanceOf(NetworkError);
    expect(lost.requests).toHaveLength(1);
  });

  it('retries any command whose connection was refused: nothing reached the API', async () => {
    const { promise, requests } = call({ retry: false }, (_, n) => (n === 1 ? refused() : json(200, {})));
    expect((await promise).status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  it('retries a GET after a lost connection, and reports the key after the last failure', async () => {
    const get = call({ method: 'GET', retry: true }, (_, n) => (n === 1 ? reset() : json(200, { a: 1 })));
    expect((await get.promise).json).toEqual({ a: 1 });
    const failing = call(keyed, () => reset());
    const err = await failing.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).idempotencyKey).toBe('k-1');
    expect((err as NetworkError).reason).toBe('ECONNRESET');
    expect(failing.requests).toHaveLength(MAX_RETRIES + 1);
  });

  it('notices a replayed answer', async () => {
    const { promise } = call(keyed, () => json(201, { id: 1 }, { 'idempotent-replayed': 'true' }));
    expect((await promise).replayed).toBe(true);
  });
});
