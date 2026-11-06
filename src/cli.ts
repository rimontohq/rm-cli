// The CLI: finds the command, parses its flags, calls the API, prints the answer. Everything outside this process
// (argv, environment, streams, fetch, the clock, files) comes in through Io, so the tests run it whole.

import { GLOBAL_FLAGS, buildInput, commandFlags, globalOptions, parseLine, type FlagSpec, type ParsedLine } from './args.ts';
import { authStatus, login, logout } from './auth.ts';
import { configPath, readConfig, type Config } from './config.ts';
import { resolveContext, type Context, type GlobalOptions } from './context.ts';
import { CliError, EXIT, NetworkError, UsageError } from './errors.ts';
import { TABLE } from './generated/commands.ts';
import { areaByName, builtinHelp, commandHelp, listHelp, rootHelp } from './help.ts';
import { defaultHeaders, send, type HttpResponse } from './http.ts';
import { listKeyOf, renderHuman, renderJson, type RenderOptions } from './output.ts';
import { collectPages } from './paginate.ts';
import { describeFailure, retryHint } from './problem.ts';
import { readAll, type TtyInput } from './prompt.ts';
import { closest } from './suggest.ts';
import { buildTree, resolve, type Node } from './tree.ts';
import type { Command, CommandTable, ListInfo } from './types.ts';
import { VERSION } from './version.ts';

export interface Out {
  write(s: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface Io {
  argv: string[];
  env: Record<string, string | undefined>;
  stdout: Out;
  stderr: Out;
  stdin: TtyInput;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  platform: string;
  homedir: string;
  randomUUID: () => string;
  readFile: (path: string) => string;
  /** The command table; the generated one unless a test gives its own. */
  table?: CommandTable;
}

export interface CallRequest {
  method: string;
  /** From the API's root, starting with `/`; may carry a query string. */
  path: string;
  query?: [string, string][];
  body?: unknown;
  idempotencyKey?: string;
  /** Instead of the session's (login, auth status). */
  apiKey?: string;
  apiUrl?: string;
  headers?: Record<string, string>;
}

export interface Session {
  io: Io;
  table: CommandTable;
  globals: GlobalOptions;
  configPath: string;
  config: Config;
  ctx: Context;
  mode: 'json' | 'human';
  out(text: string): void;
  err(text: string): void;
  call(req: CallRequest): Promise<HttpResponse>;
  /** Prints an error answer on stderr and returns the exit code. */
  failure(res: HttpResponse, idempotencyKey?: string): number;
  print(data: unknown, opts?: RenderOptions & { next?: string }): void;
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function run(io: Io): Promise<number> {
  try {
    return await main(io);
  } catch (err) {
    return report(err, io);
  }
}

function report(err: unknown, io: Io): number {
  const line = (s: string) => io.stderr.write(`${s}\n`);
  if (err instanceof UsageError) {
    line(`rimonto: ${err.message}`);
    if (err.hint) line(err.hint);
    return EXIT.usage;
  }
  if (err instanceof NetworkError) {
    line(`rimonto: ${err.message}`);
    if (err.idempotencyKey) for (const l of retryHint(err.idempotencyKey)) line(l);
    return EXIT.network;
  }
  if (err instanceof CliError) {
    line(`rimonto: ${err.message}`);
    for (const l of err.lines) line(l);
    return err.code;
  }
  line(`rimonto: ${err instanceof Error ? err.message : String(err)}`);
  if (io.env.RIMONTO_DEBUG && err instanceof Error && err.stack) line(err.stack);
  return EXIT.failed;
}

async function main(io: Io): Promise<number> {
  const table = io.table ?? TABLE;
  const root = buildTree(table.commands);
  const { node, rest, unknown } = resolve(io.argv, root);
  const before = rest.indexOf('--');
  const flagsPart = before >= 0 ? rest.slice(0, before) : rest;
  const wantsHelp = flagsPart.includes('--help') || flagsPart.includes('-h');

  if (unknown) {
    if (node === root && areaByName(table, unknown)) {
      if (wantsHelp) return printArea(io, table, areaByName(table, unknown)!);
      throw new UsageError(`"${unknown}" is an area, not a command`, `Its commands: rimonto help ${unknown}`);
    }
    const typed = ['rimonto', ...node.words, unknown].join(' ');
    const guess = closest(unknown, node.children.keys());
    throw new UsageError(`unknown command "${typed}"`,
      guess ? `Did you mean \`rimonto ${[...node.words, guess].join(' ')}\`?` : `Run \`rimonto ${[...node.words, '--help'].join(' ')}\` for the commands.`);
  }

  if (wantsHelp) {
    io.stdout.write(`${helpFor(node, table, root)}\n`);
    return EXIT.ok;
  }
  if (node === root && flagsPart.includes('--version')) {
    io.stdout.write(`rimonto ${VERSION} (API ${table.apiVersion})\n`);
    return EXIT.ok;
  }

  const flags = [...GLOBAL_FLAGS, ...flagsOf(node)];
  const line = parseLine(rest, flags);
  const g = globalOptions(line.occurrences);

  if (!node.command && !node.builtin) {
    if (line.positionals.length) throw new UsageError(`unknown command "${['rimonto', ...node.words, line.positionals[0]].join(' ')}"`);
    io.stdout.write(`${helpFor(node, table, root)}\n`);
    return EXIT.ok;
  }
  if (node.builtin === 'help') return help(io, table, root, line.positionals);

  const session = openSession(io, table, g);
  switch (node.builtin) {
    case 'login':
      return login(session, line);
    case 'logout':
      return logout(session);
    case 'auth status':
      return authStatus(session);
    case 'api':
      return api(session, line);
    case undefined:
      return runCommand(session, node.command!, line);
  }
}

function flagsOf(node: Node): FlagSpec[] {
  if (node.command) return commandFlags(node.command);
  switch (node.builtin) {
    case 'login':
      return [{ name: 'with-key', type: 'boolean', help: '' }];
    case 'api':
      return [
        { name: 'data', short: 'd', type: 'string', help: '' },
        { name: 'query', short: 'q', type: 'string', multiple: true, help: '' },
        { name: 'paginate', type: 'boolean', help: '' },
        { name: 'idempotency-key', type: 'string', help: '' },
        { name: 'columns', type: 'string', help: '' },
      ];
    case 'logout':
    case 'auth status':
    case 'help':
    case undefined:
      return [];
  }
}

function helpFor(node: Node, table: CommandTable, root: Node): string {
  if (node === root) return rootHelp(table);
  if (node.command) return commandHelp(node.command);
  if (node.builtin) return builtinHelp(node.builtin);
  const prefix = node.words;
  const commands = table.commands.filter((c) => prefix.every((w, i) => c.words[i] === w));
  // A group of the CLI's own (`auth`): its one command's help.
  const own = [...node.children.values()].find((c) => c.builtin);
  if (!commands.length && own?.builtin) return builtinHelp(own.builtin);
  // An area of the same name (`stock`, `stores`): its other commands too.
  const area = prefix.length === 1 ? areaByName(table, prefix[0]!) : undefined;
  const more = area ? table.commands.filter((c) => c.area === area && !commands.includes(c)) : [];
  const title = `rimonto ${prefix.join(' ')}: its commands`;
  if (!more.length) return listHelp(title, commands, table, true);
  const person = [...commands, ...more].some((c) => !c.apiKey);
  return `${listHelp(title, commands, table, true, false)}\n\n${listHelp(`Also in the area ${area}`, more, table, false, true, person)}`;
}

function printArea(io: Io, table: CommandTable, area: string): number {
  const commands = table.commands.filter((c) => c.area === area);
  const description = table.areas.find((a) => a.name === area)?.description;
  io.stdout.write(`${listHelp(`${area}${description ? `: ${description}` : ''}`, commands, table, false)}\n`);
  return EXIT.ok;
}

function help(io: Io, table: CommandTable, root: Node, words: string[]): number {
  if (!words.length) {
    io.stdout.write(`${rootHelp(table)}\n`);
    return EXIT.ok;
  }
  const r = resolve(words, root);
  if (r.unknown || r.rest.length) {
    const area = words.length === 1 ? areaByName(table, words[0]!) : undefined;
    if (area) return printArea(io, table, area);
    const guess = closest(words[0]!, [...root.children.keys(), ...table.areas.map((a) => a.name.toLowerCase())]);
    throw new UsageError(`no command or area "${words.join(' ')}"`, guess ? `Did you mean \`rimonto help ${guess}\`?` : 'Run `rimonto --help`.');
  }
  io.stdout.write(`${helpFor(r.node, table, root)}\n`);
  return EXIT.ok;
}

export function openSession(io: Io, table: CommandTable, g: GlobalOptions): Session {
  const err = (s: string) => {
    io.stderr.write(`${s}\n`);
  };
  const path = configPath(io.env, io.platform, io.homedir);
  const config = readConfig(path, err);
  const ctx = resolveContext(g, io.env, config);
  if (ctx.apiUrl.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(ctx.apiUrl)) {
    err(`warning: ${ctx.apiUrl} is not https: the key travels unencrypted`);
  }
  const mode = g.json ? 'json' : g.human ? 'human' : io.stdout.isTTY ? 'human' : 'json';
  const timeoutMs = (g.timeout ?? 60) * 1000;

  const session: Session = {
    io, table, globals: g, configPath: path, config, ctx, mode,
    out: (s) => {
      io.stdout.write(`${s}\n`);
    },
    err,
    call(req) {
      const base = req.apiUrl ?? ctx.apiUrl;
      const url = new URL(base + req.path);
      for (const [k, v] of req.query ?? []) url.searchParams.append(k, v);
      const headers: Record<string, string> = defaultHeaders();
      const key = req.apiKey ?? ctx.apiKey;
      if (key) headers.authorization = `Bearer ${key}`;
      for (const [k, v] of Object.entries(req.headers ?? ctx.headers)) setHeader(headers, k, v);
      let body: string | undefined;
      if (req.body !== undefined) {
        body = JSON.stringify(req.body);
        setHeader(headers, 'content-type', 'application/json');
      }
      if (req.idempotencyKey) setHeader(headers, 'idempotency-key', req.idempotencyKey);
      const method = req.method.toUpperCase();
      return send(
        { method, url: url.toString(), headers, body, retry: IDEMPOTENT_METHODS.has(method) || Boolean(req.idempotencyKey), idempotencyKey: req.idempotencyKey },
        { fetch: io.fetch, sleep: io.sleep, timeoutMs, log: g.verbose ? err : undefined },
      );
    },
    failure(res, idempotencyKey) {
      for (const l of describeFailure(res, { apiUrl: ctx.apiUrl, keySource: ctx.keySource, profileName: ctx.profileName, idempotencyKey })) err(l);
      return EXIT.failed;
    },
    print(data, opts = {}) {
      if (mode === 'json') {
        if (data !== undefined) session.out(typeof data === 'string' ? data : renderJson(data));
        return;
      }
      if (data === undefined || data === '') {
        err('Done.');
        return;
      }
      // A terminal says how wide it is; when it says nothing (0, or not a terminal with --human), COLUMNS or 120.
      session.out(renderHuman(data, { ...opts, width: io.stdout.columns || Number(io.env.COLUMNS) || undefined }));
      if (opts.next) err(opts.next);
    },
  };
  return session;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
  headers[name] = value;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

export function requireSignIn(s: Session): void {
  if (s.ctx.apiKey || headerValue(s.ctx.headers, 'authorization')) return;
  const profile = s.ctx.profileName === 'default' ? '' : ` --profile ${s.ctx.profileName}`;
  throw new CliError('not signed in', [`Run \`rimonto login${profile}\`, or set RIMONTO_API_KEY.`]);
}

async function readData(io: Io, spec: string): Promise<string> {
  if (spec === '-') return readAll(io.stdin);
  if (spec.startsWith('@')) {
    try {
      return io.readFile(spec.slice(1));
    } catch (err) {
      throw new UsageError(`cannot read ${spec.slice(1)}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  }
  return spec;
}

/** A generated command: the API operation it names. */
async function runCommand(s: Session, cmd: Command, line: ParsedLine): Promise<number> {
  const input = await buildInput(cmd, line, (spec) => readData(s.io, spec));
  if (cmd.auth) requireSignIn(s);
  const path = cmd.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(input.params[name] ?? ''));
  let key = input.idempotencyKey ?? headerValue(s.ctx.headers, 'idempotency-key');
  if (!key && cmd.idempotency) key = s.io.randomUUID();
  const list = cmd.list;
  const base = { method: cmd.method, path, body: input.body, idempotencyKey: key };
  const words = `rimonto ${cmd.words.join(' ')}`;

  if (list?.pageToken && (input.list.all || input.list.limit !== undefined)) {
    const r = await collectPages((token, size) => s.call({
      ...base,
      query: [...input.query, ...(token ? [[list.pageToken!, token]] : []), ...(size && list.pageSize ? [[list.pageSize, String(size)]] : [])] as [string, string][],
    }), { key: list.key, all: input.list.all, limit: input.list.limit, pageSize: input.list.pageSize, pageToken: input.list.pageToken });
    if (!r.ok) return s.failure(r.response, key);
    s.print(r.data, { list, columns: input.columns, next: nextHint(r.data, words) });
    return EXIT.ok;
  }

  const query = [...input.query];
  if (list?.pageToken && input.list.pageToken) query.push([list.pageToken, input.list.pageToken]);
  if (list?.pageSize && input.list.pageSize) query.push([list.pageSize, String(input.list.pageSize)]);
  const res = await s.call({ ...base, query });
  return finish(s, res, key, { list, columns: input.columns, words });
}

function finish(s: Session, res: HttpResponse, key: string | undefined, opts: { list?: ListInfo; columns?: string[]; words: string }): number {
  if (res.status < 200 || res.status >= 300) return s.failure(res, key);
  if (res.replayed && s.io.stderr.isTTY) s.err(`Replayed: idempotency key ${key} was used before, so this is the first answer to it.`);
  const data = res.json !== undefined ? res.json : res.text || undefined;
  s.print(data, { list: opts.list, columns: opts.columns, next: nextHint(data, opts.words) });
  return EXIT.ok;
}

function nextHint(data: unknown, words: string): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const token = (data as Record<string, unknown>).next_page_token;
  return typeof token === 'string' && token ? `More rows: ${words} --page-token ${token} (or --all)` : undefined;
}

/** `rimonto api <METHOD> <path>`: any call, with the session's sign-in, retries and output. */
async function api(s: Session, line: ParsedLine): Promise<number> {
  const pos = line.positionals;
  let method = 'GET';
  let rawPath: string | undefined;
  if (pos.length === 1) rawPath = pos[0];
  else if (pos.length === 2) [method, rawPath] = [pos[0]!.toUpperCase(), pos[1]];
  else if (pos.length > 2) throw new UsageError(`unexpected argument "${pos[2]}"`, 'Usage: rimonto api <METHOD> <path>');
  if (!rawPath) throw new UsageError('missing <path>', 'Usage: rimonto api <METHOD> <path>, like rimonto api GET /whoami');
  if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method)) throw new UsageError(`not an HTTP method: ${pos[0]}`);
  if (/^https?:\/\//i.test(rawPath)) throw new UsageError('give a path, like /whoami', 'The address comes from --api-url, RIMONTO_API_URL or the profile, so the key only goes there.');
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  const opt = (name: string) => line.occurrences.filter((o) => o.name === name).map((o) => o.value);
  const query: [string, string][] = opt('query').map((q) => {
    const pair = String(q);
    const i = pair.indexOf('=');
    if (i <= 0) throw new UsageError(`-q takes key=value (got "${pair}")`);
    return [pair.slice(0, i), pair.slice(i + 1)];
  });
  let body: unknown;
  const data = opt('data').pop();
  if (data !== undefined) {
    const text = await readData(s.io, String(data));
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`--data is not valid JSON: ${(err as Error).message}`);
    }
  }
  const columns = opt('columns').pop();
  const cmd = matchOperation(s.table, method, path.split('?')[0]!);
  let key = (opt('idempotency-key').pop() as string | undefined) ?? headerValue(s.ctx.headers, 'idempotency-key');
  if (!key && cmd?.idempotency) key = s.io.randomUUID();
  if (cmd?.auth) requireSignIn(s);
  const words = `rimonto api ${method} ${path}`;
  const columnList = columns ? String(columns).split(',').map((c) => c.trim()).filter(Boolean) : undefined;

  if (opt('paginate').length) {
    if (method !== 'GET') throw new UsageError('--paginate is for GET lists');
    const first = await s.call({ method, path, query });
    if (first.status < 200 || first.status >= 300) return s.failure(first);
    const listKey = cmd?.list?.key ?? (isObj(first.json) ? listKeyOf(first.json) : undefined);
    if (!listKey) throw new UsageError('this answer is not a list: drop --paginate');
    let fetched = false;
    const r = await collectPages(async (token) => {
      if (!fetched) {
        fetched = true;
        return first;
      }
      return s.call({ method, path, query: [...query, ['page_token', token ?? '']] });
    }, { key: listKey, all: true });
    if (!r.ok) return s.failure(r.response);
    s.print(r.data, { list: cmd?.list, columns: columnList });
    return EXIT.ok;
  }

  const res = await s.call({ method, path, query, body, idempotencyKey: key });
  return finish(s, res, key, { list: cmd?.list, columns: columnList, words });
}

/** The operation a raw method and path stand for, if the table has it: for its idempotency and list shape. */
export function matchOperation(table: CommandTable, method: string, path: string): Command | undefined {
  return table.commands.find((c) => {
    if (c.method !== method) return false;
    const re = new RegExp(`^${c.path.split(/\{[^}]+\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/:]+')}/?$`);
    return re.test(path);
  });
}
