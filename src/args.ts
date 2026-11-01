// Flags and arguments: the global flags every command has, and a command's own, built from its entry in the
// command table: path parameters are positional, query parameters and top-level scalar body fields are typed flags,
// and the rest of the body comes from --data. Flags override --data's keys.

import { parseArgs } from 'node:util';
import { UsageError } from './errors.ts';
import type { GlobalOptions } from './context.ts';
import { closest } from './suggest.ts';
import type { Command, Field } from './types.ts';

export interface FlagSpec {
  name: string;
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  /** The value's placeholder in help: `<name>`, `<json>`. */
  value?: string;
  help: string;
  /** For a field's flag: the field. */
  field?: Field;
  /** For `--no-x`: the field it turns off. */
  negates?: Field;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'profile', type: 'string', value: 'name', help: 'The profile to use (default: RIMONTO_PROFILE, else "default")' },
  { name: 'api-url', type: 'string', value: 'url', help: 'The API address (default: RIMONTO_API_URL, the profile\'s, else https://rimonto.app/core)' },
  { name: 'header', short: 'H', type: 'string', multiple: true, value: '"Name: value"', help: 'An extra request header; repeat for more (also RIMONTO_HEADERS)' },
  { name: 'json', type: 'boolean', help: 'Print JSON (the default when the output is not a terminal)' },
  { name: 'human', type: 'boolean', help: 'Print tables and records (the default in a terminal)' },
  { name: 'verbose', type: 'boolean', help: 'Show each request and answer on stderr (header values hidden)' },
  { name: 'timeout', type: 'string', value: 'seconds', help: 'How long to wait for each answer (default 60)' },
  { name: 'help', short: 'h', type: 'boolean', help: 'Show help' },
  { name: 'version', type: 'boolean', help: 'Show the version' },
];

export const GLOBAL_VALUE_FLAGS = new Set(['--profile', '--api-url', '--header', '-H', '--timeout']);

export const DATA_FLAG: FlagSpec = {
  name: 'data', short: 'd', type: 'string', value: 'json',
  help: 'The request body: JSON, @file.json, or - for stdin. Flags override its keys',
};

/** A command's own flags, after the global ones. */
export function commandFlags(cmd: Command): FlagSpec[] {
  const flags: FlagSpec[] = [];
  for (const f of [...cmd.query, ...(cmd.body?.fields ?? [])]) {
    if (!f.flag) continue;
    if (f.type === 'boolean') {
      flags.push({ name: f.flag, type: 'boolean', help: f.description ?? '', field: f });
      flags.push({ name: `no-${f.flag}`, type: 'boolean', help: '', negates: f });
    } else {
      flags.push({ name: f.flag, type: 'string', multiple: f.type === 'array', value: valueName(f), help: f.description ?? '', field: f });
    }
  }
  if (cmd.body) flags.push(DATA_FLAG);
  if (cmd.idempotency) {
    flags.push({ name: 'idempotency-key', type: 'string', value: 'key', help: 'Use this key instead of a new one: the same key as a failed attempt retries it safely' });
  }
  if (cmd.list) {
    if (cmd.list.pageToken) {
      flags.push({ name: 'all', type: 'boolean', help: 'Fetch every page' });
      flags.push({ name: 'limit', type: 'string', value: 'n', help: 'Stop after n rows, fetching more pages as needed' });
      if (cmd.list.pageSize) flags.push({ name: 'page-size', type: 'string', value: 'n', help: 'Rows per page' });
      flags.push({ name: 'page-token', type: 'string', value: 'token', help: 'Start from this page (next_page_token of the previous one)' });
    }
    flags.push({ name: 'columns', type: 'string', value: 'a,b,c', help: 'The table\'s columns (human output)' });
  }
  return flags;
}

export function valueName(f: Field): string {
  const t = f.type === 'array' ? f.items ?? 'value' : f.type;
  if (f.enum) return 'value';
  if (f.format === 'uuid') return 'id';
  if (t === 'integer') return f.name.endsWith('_minor') ? 'minor-units' : 'n';
  return t === 'string' ? (f.format ?? 'text') : t;
}

export interface Occurrence {
  name: string;
  value: string | boolean;
}

export interface ParsedLine {
  occurrences: Occurrence[];
  positionals: string[];
}

/** Parses argv against these flags; an unknown flag is a usage error with the closest known one. */
export function parseLine(argv: string[], flags: FlagSpec[]): ParsedLine {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const f of flags) options[f.name] = { type: f.type, ...(f.short ? { short: f.short } : null), multiple: true };
  let tokens;
  try {
    tokens = parseArgs({ args: argv, options, strict: true, allowPositionals: true, tokens: true }).tokens;
  } catch (err) {
    const e = err as { code?: string; message: string };
    if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const flag = /'(-[^']+)'/.exec(e.message)?.[1] ?? '';
      const name = flag.replace(/^-+/, '').split('=')[0]!;
      const guess = closest(name, flags.map((f) => f.name));
      throw new UsageError(`unknown flag ${flag}`, guess ? `Did you mean --${guess}?` : undefined);
    }
    throw new UsageError(e.message.replace(/\.$/, ''));
  }
  const occurrences: Occurrence[] = [];
  const positionals: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'option') occurrences.push({ name: t.name, value: t.value ?? true });
    else if (t.kind === 'positional') positionals.push(t.value);
  }
  return { occurrences, positionals };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function globalOptions(occ: Occurrence[]): GlobalOptions & { help: boolean; version: boolean } {
  const last = (name: string) => occ.findLast((o) => o.name === name)?.value;
  const timeout = last('timeout');
  let seconds: number | undefined;
  if (typeof timeout === 'string') {
    seconds = Number(timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError(`--timeout must be a number of seconds (got "${timeout}")`);
  }
  return {
    profile: str(last('profile')),
    apiUrl: str(last('api-url')),
    headers: occ.filter((o) => o.name === 'header').map((o) => String(o.value)),
    json: last('json') === true,
    human: last('human') === true,
    verbose: last('verbose') === true,
    timeout: seconds,
    help: last('help') === true,
    version: last('version') === true,
  };
}

export interface CommandInput {
  /** Path parameters by name. */
  params: Record<string, string>;
  query: [string, string][];
  /** The JSON body; undefined when there is none to send. */
  body?: unknown;
  idempotencyKey?: string;
  list: { all: boolean; limit?: number; pageSize?: number; pageToken?: string };
  columns?: string[];
}

/** Reads --data's value: the JSON itself, `@file`, or `-` for stdin. */
export type DataReader = (spec: string) => Promise<string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function buildInput(cmd: Command, line: ParsedLine, readData: DataReader): Promise<CommandInput> {
  const name = cmd.words.join(' ');
  const flags = commandFlags(cmd);
  const byName = new Map(flags.map((f) => [f.name, f]));

  // Path parameters.
  if (line.positionals.length < cmd.args.length) {
    const missing = cmd.args.slice(line.positionals.length).map((a) => `<${a.label}>`).join(' ');
    throw new UsageError(`${name}: missing ${missing}`, `Usage: ${usage(cmd)}`);
  }
  if (line.positionals.length > cmd.args.length) {
    throw new UsageError(`${name}: unexpected argument "${line.positionals[cmd.args.length]}"`, `Usage: ${usage(cmd)}`);
  }
  const params: Record<string, string> = {};
  cmd.args.forEach((a, i) => {
    const v = line.positionals[i]!;
    if (a.format === 'uuid' && !UUID.test(v)) {
      throw new UsageError(`${name}: <${a.label}> must be an id (a UUID), got "${v}"`);
    }
    params[a.name] = v;
  });

  // Flags, in order: a later one wins, an array flag adds up.
  const values = new Map<Field, unknown>();
  const input: CommandInput = { params, query: [], list: { all: false } };
  let data: string | undefined;
  for (const o of line.occurrences) {
    const spec = byName.get(o.name);
    if (!spec) continue;
    if (spec.negates) values.set(spec.negates, false);
    else if (spec.field) {
      const f = spec.field;
      if (f.type === 'boolean') values.set(f, true);
      else if (f.type === 'array') {
        // `--status new,ready` as well as `--status new --status ready`, where a value cannot hold a comma itself.
        const split = f.enum || f.format === 'uuid' || f.items === 'integer' || f.items === 'number';
        const parts = split ? String(o.value).split(',').map((p) => p.trim()).filter(Boolean) : [String(o.value)];
        values.set(f, [...((values.get(f) as unknown[]) ?? []), ...parts.map((p) => convert(f, p, f.items ?? 'string'))]);
      }
      else values.set(f, convert(f, String(o.value), f.type));
    } else if (o.name === 'data') data = String(o.value);
    else if (o.name === 'idempotency-key') input.idempotencyKey = String(o.value);
    else if (o.name === 'all') input.list.all = true;
    else if (o.name === 'limit') input.list.limit = positiveInt('limit', o.value);
    else if (o.name === 'page-size') input.list.pageSize = positiveInt('page-size', o.value);
    else if (o.name === 'page-token') input.list.pageToken = String(o.value);
    else if (o.name === 'columns') input.columns = String(o.value).split(',').map((c) => c.trim()).filter(Boolean);
  }

  // Query.
  for (const f of cmd.query) {
    if (!values.has(f)) continue;
    const v = values.get(f);
    for (const item of Array.isArray(v) ? v : [v]) input.query.push([f.name, item === null ? 'null' : String(item)]);
  }
  const missingQuery = cmd.query.filter((f) => f.required && !values.has(f));

  // Body: --data, then the flags on top.
  let body: unknown;
  if (data !== undefined) {
    if (!cmd.body) throw new UsageError(`${name} takes no body: drop --data`);
    const text = await readData(data);
    try {
      body = JSON.parse(text);
    } catch (err) {
      throw new UsageError(`--data is not valid JSON: ${(err as Error).message}`);
    }
  }
  const bodyFlags = (cmd.body?.fields ?? []).filter((f) => values.has(f));
  if (bodyFlags.length) {
    if (body === undefined) body = {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new UsageError('--data must be a JSON object when flags add fields to it');
    }
    for (const f of bodyFlags) (body as Record<string, unknown>)[f.name] = values.get(f);
  }
  if (cmd.body && body === undefined && cmd.body.required) body = {};

  // Required fields, all reported at once.
  const missing: string[] = missingQuery.map(describeMissing);
  if (cmd.body && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    for (const f of cmd.body.fields) if (f.required && !(f.name in body)) missing.push(describeMissing(f));
  }
  if (missing.length) {
    throw new UsageError(`${name}: missing ${missing.join(', ')}`, `Run \`rimonto ${name} --help\` for its flags.`);
  }
  input.body = body;
  return input;
}

function describeMissing(f: Field): string {
  if (!f.flag) return `"${f.name}" (set it in --data)`;
  return f.enum ? `--${f.flag} (one of: ${f.enum.join(', ')})` : `--${f.flag}`;
}

function convert(f: Field, raw: string, type: string): unknown {
  const flag = `--${f.flag}`;
  let value: unknown = raw;
  if (raw === 'null' && f.nullable && type !== 'string') return null;
  if (type === 'integer') {
    if (!/^-?\d+$/.test(raw.trim())) {
      const hint = f.name.endsWith('_minor') ? 'Money is in minor units: 2500 for 25.00.' : undefined;
      throw new UsageError(`${flag} must be a whole number (got "${raw}")`, hint);
    }
    value = Number(raw);
  } else if (type === 'number') {
    value = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) throw new UsageError(`${flag} must be a number (got "${raw}")`);
  } else if (type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') throw new UsageError(`${flag} must be true or false (got "${raw}")`);
    value = raw === 'true';
  }
  if (f.enum && !f.enum.includes(value as string | number | boolean)) {
    const guess = closest(raw, f.enum.map(String));
    throw new UsageError(`${flag} must be one of: ${f.enum.join(', ')} (got "${raw}")`, guess ? `Did you mean ${guess}?` : undefined);
  }
  return value;
}

function positiveInt(flag: string, v: string | boolean): number {
  const s = String(v);
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new UsageError(`--${flag} must be a whole number above 0 (got "${s}")`);
  return Number(s);
}

/** `rimonto tickets set-status <id> [flags]` */
export function usage(cmd: Command): string {
  return ['rimonto', ...cmd.words, ...cmd.args.map((a) => `<${a.label}>`), '[flags]'].join(' ');
}
