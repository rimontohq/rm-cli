import { describe, expect, it } from 'vitest';
import type { HttpResponse } from '../src/http.ts';
import { collectPages } from '../src/paginate.ts';

function page(rows: number[], next?: string, status = 200): HttpResponse {
  const body = { tickets: rows.map((id) => ({ id })), ...(next ? { next_page_token: next } : null) };
  return { status, statusText: '', headers: new Headers(), contentType: 'application/json', text: JSON.stringify(body), json: body, replayed: false, attempts: 1 };
}

/** 7 rows, 3 per page unless asked for fewer: tokens t3, t6. */
function server() {
  const calls: { token?: string; size?: number }[] = [];
  const fetchPage = async (token: string | undefined, size: number | undefined) => {
    calls.push({ token, size });
    const start = token ? Number(token.slice(1)) : 0;
    const n = Math.min(size ?? 3, 3);
    const rows = [0, 1, 2, 3, 4, 5, 6].slice(start, start + n);
    const end = start + rows.length;
    return page(rows, end < 7 ? `t${end}` : undefined);
  };
  return { calls, fetchPage };
}

describe('collectPages', () => {
  it('follows next_page_token to the end with all, in the shape of one page', async () => {
    const { calls, fetchPage } = server();
    const r = await collectPages(fetchPage, { key: 'tickets', all: true });
    expect(r.ok && r.data).toEqual({ tickets: [0, 1, 2, 3, 4, 5, 6].map((id) => ({ id })) });
    expect(calls.map((c) => c.token)).toEqual([undefined, 't3', 't6']);
  });

  it('stops at limit, asking for no more rows than it needs, and keeps the token to go on', async () => {
    const { calls, fetchPage } = server();
    const r = await collectPages(fetchPage, { key: 'tickets', all: false, limit: 5 });
    expect(r.ok && r.data).toEqual({ tickets: [0, 1, 2, 3, 4].map((id) => ({ id })), next_page_token: 't5' });
    expect(calls).toEqual([{ token: undefined, size: 5 }, { token: 't3', size: 2 }]);
  });

  it('starts from a page token and keeps the page size', async () => {
    const { calls, fetchPage } = server();
    const r = await collectPages(fetchPage, { key: 'tickets', all: true, pageToken: 't3', pageSize: 2 });
    expect(r.ok && (r.data.tickets as unknown[]).length).toBe(4);
    expect(calls[0]).toEqual({ token: 't3', size: 2 });
  });

  it('drops the token when a page held more rows than asked for', async () => {
    const r = await collectPages(async () => page([1, 2, 3, 4], 'next'), { key: 'tickets', all: false, limit: 2 });
    expect(r.ok && r.data).toEqual({ tickets: [{ id: 1 }, { id: 2 }] });
  });

  it('stops when a token comes back again', async () => {
    let n = 0;
    const r = await collectPages(async () => {
      n++;
      return page([n], 'same');
    }, { key: 'tickets', all: true });
    expect(n).toBe(2);
    expect(r.ok && (r.data.tickets as unknown[]).length).toBe(2);
  });

  it('returns the failing answer', async () => {
    let n = 0;
    const r = await collectPages(async () => (++n === 1 ? page([1], 'a') : page([], undefined, 503)), { key: 'tickets', all: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.response.status).toBe(503);
  });
});
