// A whole CLI run with no network, terminal or real config: argv in, stdout/stderr/exit code and the requests out.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { run, type Io } from '../src/cli.ts';
import { generate } from '../src/generate.ts';
import type { CommandTable } from '../src/types.ts';

export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Handler = (req: SentRequest, n: number) => Response | Error | Promise<Response | Error>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': type, ...headers } });
}

export function problem(status: number, code: string, title: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { type: `urn:rimonto:problem:${code}`, title, status, code, ...extra });
}

/** A fetch that records each request and answers with the handler. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; requests: SentRequest[] } {
  const requests: SentRequest[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const req: SentRequest = { method: init?.method ?? 'GET', url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, headers, body };
    requests.push(req);
    const out = await handler(req, requests.length);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

/** fetch's error for a refused connection. */
export function refused(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

export function reset(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  requests: SentRequest[];
  sleeps: number[];
  home: string;
}

export interface RunOptions {
  env?: Record<string, string>;
  tty?: boolean;
  stdin?: string;
  /** What a person types into a terminal on stdin (with its Enter): stdin is then a TTY. */
  typed?: string;
  handler?: Handler;
  home?: string;
  table?: CommandTable;
  files?: Record<string, string>;
}

let uuid = 0;

/** A terminal's stdin: the text is typed once something reads it. */
function terminal(typed: string): Io['stdin'] {
  const t = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => undefined,
    setEncoding: () => undefined,
    pause: () => undefined,
    resume: () => setImmediate(() => t.emit('data', typed)),
  });
  return t as unknown as Io['stdin'];
}

export async function cli(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const sleeps: number[] = [];
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'rimonto-test-'));
  const { fetch, requests } = fakeFetch(opts.handler ?? (() => json(200, {})));
  const stdin = opts.typed === undefined ? (Readable.from(opts.stdin === undefined ? [] : [opts.stdin]) as unknown as Io['stdin']) : terminal(opts.typed);
  if (opts.typed === undefined) (stdin as { isTTY?: boolean }).isTTY = false;
  const io: Io = {
    argv,
    env: { XDG_CONFIG_HOME: join(home, 'config'), ...opts.env },
    stdout: { write: (s: string) => (stdout += s), isTTY: opts.tty ?? false, columns: 200 },
    stderr: { write: (s: string) => (stderr += s), isTTY: false },
    stdin,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    platform: 'linux',
    homedir: home,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    readFile: (path) => {
      if (opts.files && path in opts.files) return opts.files[path]!;
      return readFileSync(path, 'utf8');
    },
    table: opts.table,
  };
  const code = await run(io);
  return { code, stdout, stderr, requests, sleeps, home };
}

/** The command table of the checked-in spec. */
export function specTable(): CommandTable {
  return generate(JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8')));
}

/** `GET /<collection>`: a list with pages, a filter and its own response schema. */
const listOperation = (name: string, item: string) => ({
  get: {
    operationId: `list${item}s`,
    summary: `List ${name}`,
    tags: ['Repairs'],
    security: [{ bearer: [] }, { apiKey: [] }],
    parameters: [
      { name: 'status', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['new', 'ready'] } } },
      { name: 'max_page_size', in: 'query', schema: { type: 'integer' } },
      { name: 'page_token', in: 'query', schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: 'A page',
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${item}List` } } },
      },
    },
  },
});

/** A small API with lists, as `GET /<collection>` will look: for tests that need reads. */
export function listsSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '9.9.9' },
    paths: {
      '/tickets': {
        ...listOperation('repairs', 'Ticket'),
        post: {
          operationId: 'createTicket',
          summary: 'Check a repair in',
          tags: ['Repairs'],
          security: [{ bearer: [] }, { apiKey: [] }],
          parameters: [{ name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    store_id: { type: 'string', format: 'uuid' },
                    problem: { type: 'string' },
                    deposit_minor: { type: 'integer' },
                    services: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
                  },
                  required: ['store_id', 'problem', 'services'],
                },
              },
            },
          },
          responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } } },
        },
      },
      '/tickets/{id}': {
        get: {
          operationId: 'getTicket',
          summary: 'A repair',
          tags: ['Repairs'],
          security: [{ bearer: [] }, { apiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { 200: { description: 'The repair', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } } },
        },
      },
      '/tickets/{id}:set-status': {
        post: {
          operationId: 'setStatusTicket',
          summary: 'Move a repair to another status',
          tags: ['Repairs'],
          security: [{ bearer: [] }, { apiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string', enum: ['new', 'ready'] }, text: { type: 'string' } }, required: ['status'] },
              },
            },
          },
          responses: { 200: { description: 'OK' } },
        },
      },
      '/whoami': {
        get: {
          operationId: 'whoami',
          summary: 'Who a request runs as',
          tags: ['API keys'],
          security: [{ bearer: [] }, { apiKey: [] }],
          responses: { 200: { description: 'The caller', content: { 'application/json': { schema: { type: 'object', properties: { kind: { type: 'string' } } } } } } },
        },
      },
      '/api-keys': {
        post: {
          operationId: 'createApiKey',
          summary: 'Make an API key',
          tags: ['API keys'],
          security: [{ bearer: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
          responses: { 201: { description: 'Made' } },
        },
      },
    },
    components: {
      schemas: {
        Ticket: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            store_id: { type: 'string', format: 'uuid' },
            number: { type: 'string' },
            status: { type: 'string' },
            currency: { type: 'string' },
            total_minor: { type: 'integer' },
            created_at: { type: 'string' },
            checks: { type: 'array', items: { type: 'object' } },
          },
        },
        TicketList: {
          type: 'object',
          properties: { tickets: { type: 'array', items: { $ref: '#/components/schemas/Ticket' } }, next_page_token: { type: 'string' } },
          required: ['tickets'],
        },
      },
    },
  };
}
