import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from '../src/generate.ts';
import { cli, json, listsSpec, problem, refused } from './helpers.ts';

const KEY = 'rimonto_sk_live_abcdefgh1234';
const ID = '6f1c2a0e-6d8b-4a59-9d1f-3c1f6f3b8e21';
const STORE = '51000000-0000-4000-8000-000000000001';
const signedIn = { RIMONTO_API_KEY: KEY };
const lists = generate(listsSpec());
const caller = {
  kind: 'api_key', company_id: 'c1000000-0000-4000-8000-000000000001', role: 'staff', roles: ['Front desk'],
  all_stores: false, store_ids: [STORE], api_key: { id: ID, name: 'Website bookings', title: 'Front desk' },
};

describe('help and usage', () => {
  it('lists the areas and the first commands', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^rimonto \d+\.\d+\.\d+: your repair shop's API from a terminal\./);
    expect(r.stdout).toMatch(/\n {2}Repairs +tickets\n/);
    expect(r.stdout).toContain('login ');
    expect((await cli([])).stdout).toBe(r.stdout);
  });

  it('lists a group\'s commands, and an area\'s', async () => {
    const group = await cli(['tickets', '--help']);
    expect(group.stdout).toContain('tickets set-status <id>');
    expect(group.stdout).toContain('Move a repair to another status');
    expect((await cli(['tickets'])).stdout).toBe(group.stdout);
    const area = await cli(['help', 'api-keys']);
    expect(area.code).toBe(0);
    expect(area.stdout).toContain('api-keys create *');
    expect(area.stdout).toContain("needs a person's own sign-in");
    const repairs = await cli(['help', 'repairs']);
    expect(repairs.stdout).toMatch(/^Repairs\n/);
  });

  it('shows one command\'s flags, types, allowed values and an example', async () => {
    const r = await cli(['tickets', 'set-status', '--help']);
    expect(r.stdout).toContain('rimonto tickets set-status <id> [flags]');
    expect(r.stdout).toMatch(/--status <value> +Required\. One of: new, diagnosing/);
    expect(r.stdout).toContain('Example\n  rimonto tickets set-status <id> --status new');
    expect((await cli(['api-keys', 'create', '--help'])).stdout).toContain("Needs a person's own sign-in");
    expect((await cli(['login', '--help'])).stdout).toContain('later version');
  });

  it('suggests the closest command, and exits 64', async () => {
    const r = await cli(['tickts', 'list']);
    expect(r.code).toBe(64);
    expect(r.stderr).toBe('rimonto: unknown command "rimonto tickts"\nDid you mean `rimonto tickets`?\n');
    const verb = await cli(['tickets', 'set-stauts']);
    expect(verb.stderr).toContain('Did you mean `rimonto tickets set-status`?');
  });

  it('prints its version', async () => {
    expect((await cli(['--version'])).stdout).toMatch(/^rimonto \d+\.\d+\.\d+ \(API \d/);
  });
});

describe('commands', () => {
  it('sends a command with the key, a new Idempotency-Key and the JSON body, and prints JSON in a pipe', async () => {
    const r = await cli(['customers', 'create', '--store-id', STORE, '--first-name', 'Ana', '-d', '{"consent":{"updates":true,"marketing":false}}'], {
      env: signedIn,
      handler: () => json(201, { id: ID, first_name: 'Ana' }),
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ id: ID, first_name: 'Ana' });
    const [req] = r.requests;
    expect(req).toMatchObject({ method: 'POST', url: 'https://rimonto.app/core/customers' });
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(req!.headers['content-type']).toBe('application/json');
    expect(req!.body).toEqual({ consent: { updates: true, marketing: false }, store_id: STORE, first_name: 'Ana' });
  });

  it('prints a record for people in a terminal', async () => {
    const r = await cli(['tickets', 'set-status', ID, '--status', 'ready'], {
      env: signedIn, tty: true,
      handler: () => json(200, { ticket: { id: ID, number: 'T-2041', status: 'ready', deposit_minor: 2000 } }),
    });
    expect(r.stdout).toBe(`id:       ${ID}\nnumber:   T-2041\nstatus:   ready\ndeposit:  20.00\n`);
    expect(r.requests[0]!.url).toBe(`https://rimonto.app/core/tickets/${ID}:set-status`);
    expect(r.requests[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('retries a keyed command after a 503 with the same key, and tells how to retry after the last failure', async () => {
    const ok = await cli(['customers', 'create', '--store-id', STORE, '-d', '{"consent":{"updates":false,"marketing":false}}'], {
      env: signedIn,
      handler: (_, n) => (n === 1 ? problem(503, 'retry', 'Try again') : json(201, { id: ID })),
    });
    expect(ok.code).toBe(0);
    expect(ok.requests).toHaveLength(2);
    expect(ok.requests[0]!.headers['idempotency-key']).toBe(ok.requests[1]!.headers['idempotency-key']);

    const down = await cli(['customers', 'create', '--store-id', STORE, '-d', '{"consent":{"updates":false,"marketing":false}}', '--idempotency-key', 'my-key-123'], {
      env: signedIn, handler: () => refused(),
    });
    expect(down.code).toBe(2);
    expect(down.stderr).toContain('rimonto: could not reach https://rimonto.app/core/customers (ECONNREFUSED)');
    expect(down.stderr).toContain('--idempotency-key my-key-123');
    expect(down.requests.every((q) => q.headers['idempotency-key'] === 'my-key-123')).toBe(true);
  });

  it('prints a problem on stderr and exits 1', async () => {
    const r = await cli(['tickets', 'set-status', ID, '--status', 'ready'], { env: signedIn, handler: () => problem(404, 'not-found', 'No such repair') });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('rimonto: No such repair (404 not-found)\n');
  });

  it('asks for a sign-in before sending anything', async () => {
    const r = await cli(['whoami']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('rimonto: not signed in\nRun `rimonto login`, or set RIMONTO_API_KEY.\n');
    expect(r.requests).toHaveLength(0);
  });

  it('validates locally before sending', async () => {
    const r = await cli(['tickets', 'set-status', ID], { env: signedIn });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('tickets set-status: missing --status (one of: new,');
    expect(r.requests).toHaveLength(0);
  });

  it('sends extra headers and uses another API address', async () => {
    const r = await cli(['whoami', '-H', 'X-Gate-Id: abc', '--api-url', 'http://localhost:5280/'], {
      env: { ...signedIn, RIMONTO_HEADERS: 'X-Gate-Secret: s3cret' }, handler: () => json(200, caller),
    });
    expect(r.requests[0]!.url).toBe('http://localhost:5280/whoami');
    expect(r.requests[0]!.headers['x-gate-id']).toBe('abc');
    expect(r.requests[0]!.headers['x-gate-secret']).toBe('s3cret');
  });

  it('never prints header values with --verbose', async () => {
    const r = await cli(['whoami', '--verbose', '-H', 'X-Gate-Secret: s3cret'], { env: signedIn, handler: () => json(200, caller) });
    expect(r.stderr).toContain('> GET https://rimonto.app/core/whoami');
    expect(r.stderr).toContain('> x-gate-secret: <hidden>');
    expect(r.stderr).not.toContain('s3cret');
    expect(r.stderr).not.toContain(KEY);
  });
});

const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, number: `T-${from + i}`, status: 'new', currency: 'USD', total_minor: 1000 * (from + i) }));

/** Five tickets, two per page unless max_page_size says otherwise; the token is the next row's index. */
function pages(req: { url: string }) {
  const u = new URL(req.url);
  const start = Number(u.searchParams.get('page_token') ?? 0);
  const size = Number(u.searchParams.get('max_page_size') ?? 2);
  const n = Math.min(size, 5 - start);
  return json(200, { tickets: rows(start, n), ...(start + n < 5 ? { next_page_token: String(start + n) } : null) });
}

describe('lists', () => {
  it('fetches one page by default, with its filters, and says how to get more', async () => {
    const r = await cli(['tickets', 'list', '--status', 'new,ready'], { env: signedIn, table: lists, tty: true, handler: pages });
    expect(r.requests.map((q) => q.url)).toEqual(['https://rimonto.app/core/tickets?status=new&status=ready']);
    expect(r.stdout).toBe('ID  NUMBER  STATUS      TOTAL\nt0  T-0     new      0.00 USD\nt1  T-1     new     10.00 USD\n');
    expect(r.stderr).toBe('More rows: rimonto tickets list --page-token 2 (or --all)\n');
  });

  it('follows every page with --all', async () => {
    const r = await cli(['tickets', 'list', '--all'], { env: signedIn, table: lists, handler: pages });
    expect(JSON.parse(r.stdout).tickets.map((t: { id: string }) => t.id)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(r.requests).toHaveLength(3);
  });

  it('stops at --limit', async () => {
    const r = await cli(['tickets', 'list', '--limit', '3', '--page-size', '2'], { env: signedIn, table: lists, handler: pages });
    const out = JSON.parse(r.stdout);
    expect(out.tickets).toHaveLength(3);
    expect(out.next_page_token).toBe('3');
    expect(r.requests.map((q) => new URL(q.url).search)).toEqual(['?max_page_size=2', '?page_token=2&max_page_size=1']);
  });

  it('chooses columns with --columns', async () => {
    const r = await cli(['tickets', 'list', '--columns', 'number,total_minor', '--human'], { env: signedIn, table: lists, handler: pages });
    expect(r.stdout).toBe('NUMBER      TOTAL\nT-0      0.00 USD\nT-1     10.00 USD\n');
  });
});

describe('rimonto api', () => {
  it('calls any path with the same sign-in', async () => {
    const r = await cli(['api', 'GET', '/whoami'], { env: signedIn, handler: () => json(200, caller) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(caller);
    expect(r.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('adds an Idempotency-Key where the operation takes one, with -q and --data', async () => {
    const r = await cli(['api', 'post', '/tickets', '-q', 'x=1', '-d', '{"problem":"Screen"}'], { env: signedIn, table: lists, handler: () => json(201, {}) });
    expect(r.requests[0]!.url).toBe('https://rimonto.app/core/tickets?x=1');
    expect(r.requests[0]!.headers['idempotency-key']).toMatch(/^0{8}-/);
    expect(r.requests[0]!.body).toEqual({ problem: 'Screen' });
    const plain = await cli(['api', 'POST', `/tickets/${ID}:set-status`, '-d', '{"status":"new"}'], { env: signedIn, table: lists, handler: () => json(200, {}) });
    expect(plain.requests[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it('follows pages with --paginate', async () => {
    let n = 0;
    const r = await cli(['api', '/tickets', '--paginate'], {
      env: signedIn, table: lists,
      handler: () => (++n === 1 ? json(200, { tickets: [{ id: 'a' }], next_page_token: 'p2' }) : json(200, { tickets: [{ id: 'b' }] })),
    });
    expect(JSON.parse(r.stdout)).toEqual({ tickets: [{ id: 'a' }, { id: 'b' }] });
  });

  it('refuses a full URL, so the key only goes to the API address', async () => {
    const r = await cli(['api', 'GET', 'https://elsewhere.example.com/x'], { env: signedIn });
    expect(r.code).toBe(64);
    expect(r.requests).toHaveLength(0);
  });
});

describe('login, logout, auth status', () => {
  it('checks a key from stdin with GET /whoami and keeps it in a 0600 file', async () => {
    const r = await cli(['login', '--with-key', '--human'], { stdin: `${KEY}\n`, handler: () => json(200, caller) });
    expect(r.code).toBe(0);
    expect(r.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.stdout).toContain('Signed in to https://rimonto.app/core with rimonto_sk_…1234 (profile "default").');
    expect(r.stdout).toContain('Key name  Website bookings');
    expect(r.stdout).toContain('Role      staff, Front desk');
    expect(r.stdout).not.toContain(KEY);
    const path = join(r.home, 'config', 'rimonto', 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ profiles: { default: { api_key: KEY } } });

    const who = await cli(['whoami'], { home: r.home, handler: () => json(200, caller) });
    expect(who.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('keeps a profile\'s address and headers with its key', async () => {
    const r = await cli(['login', '--with-key', '--profile', 'dev', '--api-url', 'https://dev.example.com/core', '-H', 'X-Gate: g'], { stdin: KEY, handler: () => json(200, caller) });
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(join(r.home, 'config', 'rimonto', 'config.json'), 'utf8'));
    expect(config.profiles.dev).toEqual({ api_key: KEY, api_url: 'https://dev.example.com/core', headers: { 'X-Gate': 'g' } });
    const next = await cli(['whoami', '--profile', 'dev'], { home: r.home, handler: () => json(200, caller) });
    expect(next.requests[0]).toMatchObject({ url: 'https://dev.example.com/core/whoami', headers: { 'x-gate': 'g' } });
  });

  it('saves nothing when the API refuses the key', async () => {
    const r = await cli(['login', '--with-key'], { stdin: 'rimonto_sk_bad', handler: () => problem(401, 'invalid-api-key', 'This API key is not valid') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refused this key (401)');
    expect(existsSync(join(r.home, 'config', 'rimonto', 'config.json'))).toBe(false);
  });

  it('wants --with-key when there is no terminal to ask in', async () => {
    const r = await cli(['login']);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain('--with-key');
  });

  it('shows each profile, then forgets a key on logout', async () => {
    const first = await cli(['login', '--with-key'], { stdin: KEY, handler: () => json(200, caller) });
    const status = await cli(['auth', 'status', '--human'], { home: first.home, handler: () => json(200, caller) });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('default (in use)');
    expect(status.stdout).toContain('Key       rimonto_sk_…1234');
    expect(status.stdout).toContain(`Stores    1: ${STORE}`);

    const out = await cli(['logout'], { home: first.home });
    expect(out.code).toBe(0);
    expect(JSON.parse(readFileSync(join(first.home, 'config', 'rimonto', 'config.json'), 'utf8'))).toEqual({ profiles: {} });
    const after = await cli(['auth', 'status'], { home: first.home });
    expect(after.code).toBe(1);
    expect((await cli(['logout'], { home: first.home })).code).toBe(1);
  });

  it('tells how to sign in again after a 401', async () => {
    const r = await cli(['whoami'], { env: signedIn, handler: () => problem(401, 'invalid-api-key', 'This API key is not valid') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('RIMONTO_API_KEY is set: check its value');
  });
});
