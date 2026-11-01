// Following a list's pages: `{ "<plural>": [...], "next_page_token": "..." }`, the token left out on the last page.
// --all reads to the end, --limit stops after n rows. The result has the same shape as one page, so a script reads
// `.tickets[]` either way; next_page_token stays when rows are left, so a later call can go on from there.

import type { HttpResponse } from './http.ts';

export interface PageOptions {
  /** The array in each page. */
  key: string;
  all: boolean;
  limit?: number;
  pageSize?: number;
  /** Where to start. */
  pageToken?: string;
}

export type PageFetcher = (pageToken: string | undefined, pageSize: number | undefined) => Promise<HttpResponse>;

export type PagesResult = { ok: true; data: Record<string, unknown>; pages: number } | { ok: false; response: HttpResponse };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function collectPages(fetchPage: PageFetcher, opts: PageOptions): Promise<PagesResult> {
  const rows: unknown[] = [];
  let token = opts.pageToken;
  let first: Record<string, unknown> | undefined;
  let next: string | undefined;
  let pages = 0;
  const seen = new Set<string>();
  for (;;) {
    const remaining = opts.limit === undefined ? undefined : opts.limit - rows.length;
    const size = remaining === undefined ? opts.pageSize : Math.min(remaining, opts.pageSize ?? remaining);
    const res = await fetchPage(token, size);
    pages++;
    if (res.status < 200 || res.status >= 300 || !isObj(res.json) || !Array.isArray(res.json[opts.key])) return { ok: false, response: res };
    first ??= res.json;
    const page = res.json[opts.key] as unknown[];
    const nextToken = res.json.next_page_token;
    next = typeof nextToken === 'string' && nextToken ? nextToken : undefined;
    if (remaining !== undefined && page.length > remaining) {
      // More rows than asked for: the ones cut off would be skipped by the token, so it is dropped.
      rows.push(...page.slice(0, remaining));
      next = undefined;
      break;
    }
    rows.push(...page);
    if (!next) break;
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
    if (!opts.all && opts.limit === undefined) break;
    // A token that comes back again would loop forever.
    if (seen.has(next)) break;
    seen.add(next);
    token = next;
  }
  const { next_page_token: _drop, ...rest } = first ?? {};
  return { ok: true, data: { ...rest, [opts.key]: rows, ...(next ? { next_page_token: next } : null) }, pages };
}
