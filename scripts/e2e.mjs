// The CLI against a real core, as a person runs it: `npm run e2e`. Other repositories' CI runs this (the panel's api
// e2e, on a fresh local Supabase with the demo seed and core); rm-cli's own CI has no core, so it does not.
//
//   RIMONTO_E2E_API_URL  required  core's address, like http://localhost:5280
//   RIMONTO_E2E_KEY      required  a manager API key of the demo company "Fix-It Lab", for all its stores
//   RIMONTO_E2E_HEADERS  optional  extra headers, passed on as RIMONTO_HEADERS (a gate in front of core)
//   RIMONTO_E2E_CLI      optional  a built rimonto.js to test; by default this checkout is built (dist/rimonto.js)
//
// Prints one line per check, `ok …` or `FAIL …`. Exit 0 when all pass, 1 when any fails, 2 when it cannot start
// (a missing variable, a failed build). The checks hold for any seed: invariants and shapes, not exact rows, except
// for the customer it makes itself, which it erases at the end (an API key may: owners and managers erase).

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function stop(message) {
  console.error(`e2e: ${message}`);
  process.exit(2);
}

const apiUrl = process.env.RIMONTO_E2E_API_URL?.trim();
const key = process.env.RIMONTO_E2E_KEY?.trim();
if (!apiUrl || !key) stop('set RIMONTO_E2E_API_URL (core\'s address) and RIMONTO_E2E_KEY (a manager API key of the demo company)');

let cliPath = process.env.RIMONTO_E2E_CLI?.trim();
if (cliPath) cliPath = resolve(cliPath);
else {
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root, encoding: 'utf8' });
  if (build.status !== 0) stop(`the build failed:\n${build.stderr || build.stdout}`);
  cliPath = join(root, 'dist/rimonto.js');
}
if (!existsSync(cliPath)) stop(`no CLI at ${cliPath}`);

// The CLI's own environment: none of the RIMONTO_* of whoever runs this, and an empty config folder of its own.
const configHome = mkdtempSync(join(tmpdir(), 'rimonto-e2e-'));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RIMONTO_') && k !== 'COLUMNS'));
Object.assign(baseEnv, { XDG_CONFIG_HOME: configHome, APPDATA: configHome, RIMONTO_API_URL: apiUrl, RIMONTO_API_KEY: key });
if (process.env.RIMONTO_E2E_HEADERS?.trim()) baseEnv.RIMONTO_HEADERS = process.env.RIMONTO_E2E_HEADERS;

/** Runs `rimonto <args>`; `env` adds to (or, with undefined, removes from) its environment. */
function rimonto(args, env = {}) {
  const merged = { ...baseEnv, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [cliPath, ...args], { env: merged, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', line: `rimonto ${args.join(' ')}` };
}

class Failed extends Error {}

function assert(condition, message) {
  if (!condition) throw new Failed(message);
}

/** `rimonto <args> --json`, which must exit 0 and print JSON. */
function json(args, env) {
  const r = rimonto([...args, '--json'], env);
  assert(r.code === 0, `${r.line} exited ${r.code}: ${r.stderr.trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Failed(`${r.line} did not print JSON: ${r.stdout.slice(0, 200)}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let failures = 0;

/** One check: its line, `ok <name>` with what it saw, or `FAIL <name>: why`. */
function check(name, fn) {
  try {
    const seen = fn();
    console.log(`ok   ${name}${seen ? `: ${seen}` : ''}`);
    return true;
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}: ${err instanceof Failed ? err.message : err?.stack ?? err}`);
    return false;
  }
}

/** A port nothing listens on: one the system just gave out and took back. */
function closedPort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const version = rimonto(['--version']);
console.log(`e2e: ${version.stdout.trim() || cliPath} against ${apiUrl}`);

// Who the key is.
check('whoami --json: an API key with the manager role', () => {
  const me = json(['whoami']);
  assert(me.kind === 'api_key', `kind is ${me.kind}, expected api_key`);
  assert(me.role === 'manager', `role is ${me.role}, expected manager`);
  return `company ${me.company_id}, ${me.all_stores ? 'all stores' : `stores ${me.store_ids.join(', ')}`}`;
});

// Reads.
let storeId;
check('stores list --json, then stores get <id>', () => {
  const { stores } = json(['stores', 'list']);
  assert(Array.isArray(stores) && stores.length >= 1, 'no stores');
  storeId = stores[0].id;
  assert(UUID.test(storeId), `a store id is not a UUID: ${storeId}`);
  const one = json(['stores', 'get', storeId]);
  assert(one.id === storeId, `stores get ${storeId} answered id ${one.id}`);
  return `${stores.length} stores; ${one.name}, ${one.city ?? ''}`.trim();
});

let ready = [];
check('tickets list --status ready --json, then tickets get <id>', () => {
  ({ tickets: ready } = json(['tickets', 'list', '--status', 'ready']));
  assert(Array.isArray(ready), 'no tickets array');
  const other = ready.filter((t) => t.status !== 'ready');
  assert(!other.length, `rows not ready: ${other.map((t) => `${t.number} (${t.status})`).join(', ')}`);
  const pick = ready[0] ?? json(['tickets', 'list']).tickets?.[0];
  assert(pick, 'no tickets at all to read one');
  const one = json(['tickets', 'get', pick.id]);
  const ticket = one.ticket ?? one;
  assert(ticket.id === pick.id && ticket.number === pick.number, `tickets get ${pick.id} answered ${ticket.id} ${ticket.number}, expected ${pick.number}`);
  return `${ready.length} ready; ${pick.number} read back`;
});

check('customers list: --page-size 2, --all, and the pages walked by hand with --page-token', () => {
  const all = json(['customers', 'list', '--all']).customers;
  assert(Array.isArray(all), 'no customers array');
  assert(new Set(all.map((c) => c.id)).size === all.length, '--all gave the same customer twice');
  const first = json(['customers', 'list', '--page-size', '2']);
  assert(first.customers.length <= 2, `--page-size 2 gave ${first.customers.length} rows`);
  if (all.length > first.customers.length) assert(typeof first.next_page_token === 'string' && first.next_page_token, 'more customers, but no next_page_token');
  else assert(!first.next_page_token, 'a next_page_token after the last customer');
  // By hand, in at most about 25 pages.
  const size = Math.max(2, Math.ceil(all.length / 20));
  const walked = [];
  let token;
  for (let page = 0; ; page++) {
    assert(page < 100, 'more than 100 pages: the token does not move on');
    const r = json(['customers', 'list', '--page-size', String(size), ...(token ? ['--page-token', token] : [])]);
    assert(r.customers.length <= size, `a page of ${r.customers.length} rows, asked for ${size}`);
    walked.push(...r.customers.map((c) => c.id));
    token = r.next_page_token;
    if (!token) break;
  }
  assert(new Set(walked).size === walked.length, 'the pages repeat a customer');
  assert(walked.length === all.length, `the pages hold ${walked.length} customers, --all ${all.length}`);
  const allIds = new Set(all.map((c) => c.id));
  assert(walked.every((id) => allIds.has(id)), 'the pages and --all differ');
  return `${all.length} customers; pages of ${size} agree with --all`;
});

check('products list --store-id <id> --json: rows carry their stock in that store', () => {
  assert(storeId, 'no store from stores list');
  const { products } = json(['products', 'list', '--store-id', storeId]);
  assert(Array.isArray(products) && products.length, 'no products in the store');
  for (const p of products) {
    assert(p.store_id === storeId, `${p.sku}: store_id ${p.store_id}`);
    for (const f of ['on_hand', 'reserved', 'available']) assert(Number.isInteger(p[f]), `${p.sku}: ${f} is ${p[f]}`);
  }
  return `${products.length} products`;
});

check('sales list --json', () => {
  const { sales } = json(['sales', 'list']);
  assert(Array.isArray(sales) && sales.every((s) => UUID.test(s.id)), 'not a list of sales');
  return `${sales.length} sales`;
});

check('purchase-orders list --json (a manager may order parts)', () => {
  const { purchase_orders: orders } = json(['purchase-orders', 'list']);
  assert(Array.isArray(orders) && orders.every((o) => UUID.test(o.id)), 'not a list of purchase orders');
  return `${orders.length} purchase orders`;
});

// Writes: a customer of its own, made twice with one key, read back, then erased.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const lastName = `e2e ${stamp}`;
// One key for both calls, new each run: a key the API saw in an earlier run would answer with that run's customer.
const idempotencyKey = randomUUID();
// A customer needs a phone or an email; a phone already on file is refused, so an address of its own.
const email = `cli-e2e-${idempotencyKey.slice(0, 8)}@example.com`;
let customerId;
check('customers create, twice with one --idempotency-key: one customer, the second answer replayed', () => {
  assert(storeId, 'no store from stores list');
  const create = ['customers', 'create', '--store-id', storeId, '--first-name', 'CLI', '--last-name', lastName, '--email', email,
    '--data', '{"consent":{"updates":false,"marketing":false}}', '--idempotency-key', idempotencyKey];
  const first = json(create);
  customerId = (first.customer ?? first).id;
  assert(UUID.test(customerId ?? ''), `no customer id in ${JSON.stringify(first).slice(0, 200)}`);
  const again = rimonto([...create, '--json', '--verbose']);
  assert(again.code === 0, `the second create exited ${again.code}: ${again.stderr.trim()}`);
  const second = JSON.parse(again.stdout);
  assert((second.customer ?? second).id === customerId, `the second create made ${(second.customer ?? second).id}, the first ${customerId}`);
  assert(/replayed/.test(again.stderr), 'the second answer was not marked replayed (Idempotent-Replayed)');
  return `CLI ${lastName} (${customerId})`;
});

check('customers get <id>: the customer just made', () => {
  assert(customerId, 'no customer was made');
  const one = json(['customers', 'get', customerId]);
  const c = one.customer ?? one;
  assert(c.id === customerId && c.last_name === lastName, `answered ${c.id} ${c.last_name}`);
});

check('customers erase <id>: the test customer leaves no personal data behind', () => {
  assert(customerId, 'no customer was made');
  const erased = json(['customers', 'erase', customerId]);
  const c = erased.customer ?? erased;
  assert(c.id === customerId, `erase answered ${c.id}`);
  const after = json(['customers', 'get', customerId]);
  const left = after.customer ?? after;
  assert(left.last_name !== lastName, `its name is still ${left.first_name} ${left.last_name}`);
});

// For people.
check('tickets list --status ready --human (COLUMNS=100): a table with NUMBER first and the ids whole', () => {
  const r = rimonto(['tickets', 'list', '--status', 'ready', '--human'], { COLUMNS: '100' });
  assert(r.code === 0, `exited ${r.code}: ${r.stderr.trim()}`);
  const lines = r.stdout.trimEnd().split('\n');
  if (!ready.length) {
    assert(r.stdout.trim() === '(none)', `no ready tickets, but it printed ${r.stdout.slice(0, 100)}`);
    return 'no ready tickets: (none)';
  }
  assert(/^NUMBER\b/.test(lines[0]) && /\bID$/.test(lines[0]), `the header is "${lines[0]}"`);
  assert(lines.length === ready.length + 1, `${lines.length - 1} rows for ${ready.length} tickets`);
  const wide = lines.filter((l) => l.length > 100);
  assert(!wide.length, `${wide.length} lines wider than 100`);
  const ids = new Set(ready.map((t) => t.id));
  assert(lines.slice(1).every((l) => ids.has(l.split(/\s+/).pop())), 'a row does not end with its ticket\'s whole id');
  return lines[0].replace(/\s+/g, ' ');
});

// Errors.
check('api-keys create --name x: refused to an API key (exit 1, api-key-not-allowed)', () => {
  const r = rimonto(['api-keys', 'create', '--name', 'x']);
  assert(r.code !== 0, 'it made an API key: revoke "x" in the developer portal');
  assert(r.code === 1, `exited ${r.code}: ${r.stderr.trim()}`);
  assert(r.stderr.includes('api-key-not-allowed'), `stderr: ${r.stderr.trim()}`);
});

check('whoami with a key that does not exist: exit 1, the API\'s code and how to sign in', () => {
  const r = rimonto(['whoami'], { RIMONTO_API_KEY: `rimonto_sk_bogus${randomUUID().replace(/-/g, '')}` });
  assert(r.code === 1, `exited ${r.code}: ${r.stderr.trim()}`);
  const code = /\(401 ([a-z-]+)\)/.exec(r.stderr)?.[1];
  assert(code, `no 401 with a code: ${r.stderr.trim()}`);
  assert(r.stderr.includes('rimonto login'), `no sign-in hint: ${r.stderr.trim()}`);
  return code;
});

const port = await closedPort();
check(`whoami --api-url http://127.0.0.1:${port} (nothing listening): exit 2`, () => {
  const r = rimonto(['whoami', '--api-url', `http://127.0.0.1:${port}`, '--timeout', '5']);
  assert(r.code === 2, `exited ${r.code}: ${r.stderr.trim()}`);
  assert(r.stderr.includes('could not reach'), `stderr: ${r.stderr.trim()}`);
});

check('api GET /whoami', () => {
  const me = json(['api', 'GET', '/whoami']);
  assert(me.kind === 'api_key', `kind is ${me.kind}`);
});

rmSync(configHome, { recursive: true, force: true });
console.log(failures ? `e2e: ${failures} failed` : 'e2e: all passed');
process.exit(failures ? 1 : 0);
