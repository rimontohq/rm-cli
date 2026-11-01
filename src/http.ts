// One API call, with retries where they are safe.
//
// A command that takes an Idempotency-Key is sent with the same key on every attempt, so the API answers a retry with
// the first answer instead of doing the work twice. Such commands, and GET/PUT/DELETE, are retried after a network
// error, a 5xx (not 501) or a 429, up to MAX_RETRIES times, waiting as Retry-After says or backing off. Any other
// command is sent once, unless the connection could not even be opened (then nothing reached the API).

import { NetworkError } from './errors.ts';
import { VERSION } from './version.ts';

export const MAX_RETRIES = 3;
/** A Retry-After longer than this is not waited for: the error is shown instead. */
export const MAX_WAIT_MS = 60_000;

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Whether retrying is safe: the method is idempotent, or the request carries an Idempotency-Key. */
  retry: boolean;
  /** For the message after a final failure. */
  idempotencyKey?: string;
}

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  /** Lines for --verbose, on stderr. Header values are never passed here. */
  log?: (line: string) => void;
  random?: () => number;
  now?: () => number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Headers;
  contentType: string;
  text: string;
  /** The parsed body when it is JSON. */
  json?: unknown;
  /** The API answered from its idempotency record: the command had already run with this key. */
  replayed: boolean;
  attempts: number;
}

/** Errors that happen before the request leaves this computer: retrying them is always safe. */
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

export function defaultHeaders(): Record<string, string> {
  return { accept: 'application/json, application/problem+json', 'user-agent': `rimonto-cli/${VERSION} node/${process.versions.node}` };
}

export async function send(req: HttpRequest, deps: HttpDeps): Promise<HttpResponse> {
  const log = deps.log ?? (() => {});
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const backoff = (attempt: number) => Math.round(500 * 2 ** attempt + random() * 250);

  for (let attempt = 0; ; attempt++) {
    const last = attempt >= MAX_RETRIES;
    log(`> ${req.method} ${req.url}${attempt ? ` (retry ${attempt} of ${MAX_RETRIES})` : ''}`);
    for (const name of Object.keys(req.headers)) log(`> ${name.toLowerCase()}: <hidden>`);
    const started = now();
    let res: Response;
    let text: string;
    try {
      res = await deps.fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // A redirect could carry the extra headers to another host: it is reported instead (src/problem.ts).
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
      if (isRetryableStatus(res.status) && req.retry && !last) {
        const wait = retryAfter(res.headers.get('retry-after'), now()) ?? backoff(attempt);
        if (wait <= MAX_WAIT_MS) {
          await res.arrayBuffer().catch(() => undefined);
          log(`< ${res.status} ${res.statusText}: retrying in ${(wait / 1000).toFixed(1)} s`);
          await deps.sleep(wait);
          continue;
        }
      }
      text = await res.text();
    } catch (err) {
      const { reason, beforeSending } = describeError(err, deps.timeoutMs);
      if ((req.retry || beforeSending) && !last) {
        const wait = backoff(attempt);
        log(`< ${reason}: retrying in ${(wait / 1000).toFixed(1)} s`);
        await deps.sleep(wait);
        continue;
      }
      throw new NetworkError(req.url, reason, req.idempotencyKey);
    }

    const contentType = res.headers.get('content-type') ?? '';
    let json: unknown;
    if (/\bjson\b/i.test(contentType) && text) {
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON after all: kept as text
      }
    }
    const replayed = res.headers.get('idempotent-replayed') === 'true';
    log(`< ${res.status} ${res.statusText} (${now() - started} ms)${replayed ? ', replayed from the idempotency key' : ''}`);
    return { status: res.status, statusText: res.statusText, headers: res.headers, contentType, text, json, replayed, attempts: attempt + 1 };
  }
}

/** Retry-After as milliseconds from now: seconds, or an HTTP date. */
export function retryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

export function describeError(err: unknown, timeoutMs: number): { reason: string; beforeSending: boolean } {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string; name?: string } };
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') {
    return { reason: `no answer in ${Math.round(timeoutMs / 1000)} s`, beforeSending: false };
  }
  const code = e?.cause?.code ?? e?.code;
  if (code) return { reason: code, beforeSending: CONNECT_ERRORS.has(code) };
  return { reason: e?.cause?.message ?? e?.message ?? String(err), beforeSending: false };
}
