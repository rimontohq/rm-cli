// The contract tests' tools (test/contract.test.ts): the API's OpenAPI document as JSON Schema (Ajv, 2020-12, the
// dialect of OpenAPI 3.1, with formats), values made from its schemas, a command line for every command of the table,
// and the checks of a request against its operation. Test-only: nothing here is shipped.

import { readFileSync } from 'node:fs';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Command, Field } from '../src/types.ts';
import type { SentRequest } from './helpers.ts';

type Json = Record<string, unknown>;

const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

interface OpenApi {
  paths: Record<string, Json>;
  [k: string]: unknown;
}

export const spec = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8')) as OpenApi;

// The whole document is one schema to Ajv, so every `#/components/schemas/…` inside resolves; each check compiles
// `{ $ref: "openapi.json#/paths/…" }`. Not strict: OpenAPI's own keywords (`example`) sit beside JSON Schema's.
const SPEC_ID = 'openapi.json';
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(spec, SPEC_ID);

type Validator = ReturnType<typeof ajv.compile>;
const validators = new Map<string, Validator>();

/** A JSON pointer into the document, as a URI fragment. */
const pointer = (parts: (string | number)[]) =>
  parts.map((p) => encodeURIComponent(String(p).replace(/~/g, '~0').replace(/\//g, '~1'))).join('/');

/** Validates against the schema at this place in the document; undefined when valid, else Ajv's errors as text. */
export function invalid(at: (string | number)[], value: unknown, name = 'data'): string | undefined {
  const ref = `${SPEC_ID}#/${pointer(at)}`;
  let validate = validators.get(ref);
  if (!validate) {
    validate = ajv.compile({ $ref: ref });
    validators.set(ref, validate);
  }
  return validate(value) ? undefined : ajv.errorsText(validate.errors, { dataVar: name });
}

/** What is at this place in the document (unescaped keys, as `invalid` takes them). */
export function schemaAt(at: (string | number)[]): Json {
  let v: unknown = spec;
  for (const k of at) v = isObj(v) || Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  return resolve(v);
}

/** Follows local `$ref`s. */
export function resolve(v: unknown, depth = 0): Json {
  if (!isObj(v)) return {};
  if (typeof v.$ref !== 'string' || depth > 32) return v;
  let target: unknown = spec;
  for (const key of v.$ref.replace(/^#\//, '').split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    target = isObj(target) ? target[key] : undefined;
  }
  return resolve(target, depth + 1);
}

// Operations.

export interface Param {
  name: string;
  in: string;
  required: boolean;
  schema: Json;
  /** Where its schema is, for `invalid`. */
  at: (string | number)[];
}

export interface Operation {
  id: string;
  method: string;
  path: string;
  op: Json;
  params: Param[];
  /** The JSON request body's schema and its place, when the operation takes one. */
  body?: { required: boolean; schema: Json; at: (string | number)[] };
  /** The first 2xx answer, and its JSON schema's place when it has one. */
  success: { status: number; at?: (string | number)[] };
}

/** The operation a command stands for, found by its method and path. */
export function operationOf(cmd: Command): Operation {
  const item = resolve(spec.paths[cmd.path]);
  const method = cmd.method.toLowerCase();
  const op = resolve(item[method]);
  if (!Object.keys(op).length) throw new Error(`${cmd.method} ${cmd.path} is not in spec/openapi.json`);
  const params: Param[] = [];
  for (const [level, list] of [['', item.parameters], [method, op.parameters]] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((raw, i) => {
      const p = resolve(raw);
      const at = ['paths', cmd.path, ...(level ? [level] : []), 'parameters', i, 'schema'];
      const param: Param = { name: String(p.name), in: String(p.in), required: p.required === true, schema: resolve(p.schema), at };
      const same = params.findIndex((x) => x.name === param.name && x.in === param.in);
      if (same >= 0) params[same] = param;
      else params.push(param);
    });
  }
  const rb = resolve(op.requestBody);
  const json = resolve(resolve(rb.content)['application/json']);
  const body = 'schema' in json
    ? { required: rb.required === true, schema: resolve(json.schema), at: ['paths', cmd.path, method, 'requestBody', 'content', 'application/json', 'schema'] }
    : undefined;
  const responses = resolve(op.responses);
  const code = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).toSorted()[0];
  if (!code) throw new Error(`${cmd.method} ${cmd.path} has no 2xx answer`);
  const answer = resolve(resolve(resolve(responses[code]).content)['application/json']);
  const success = { status: Number(code), at: 'schema' in answer ? ['paths', cmd.path, method, 'responses', code, 'content', 'application/json', 'schema'] : undefined };
  return { id: String(op.operationId), method: cmd.method, path: cmd.path, op, params, body, success };
}

// Values made from schemas.

export interface SampleOptions {
  /** Every property of an object, or only its required ones. */
  all: boolean;
  /** null wherever the schema allows it. */
  nulls: boolean;
  /** How many items an array gets, within its minItems and maxItems. */
  items: number;
  /** What a boolean is. */
  bool: boolean;
}

/** Only the required fields, no nulls, one item per list: what a person types first. */
export const REQUIRED_INPUT: SampleOptions = { all: false, nulls: false, items: 1, bool: false };
/** Every field. */
export const EVERY_INPUT: SampleOptions = { all: true, nulls: false, items: 2, bool: true };
/** The smallest valid answer: required fields, null where allowed, two rows in a list. */
export const MINIMAL_ANSWER: SampleOptions = { all: false, nulls: true, items: 2, bool: false };
/** Every field of an answer, none null. */
export const FULL_ANSWER: SampleOptions = { all: true, nulls: false, items: 2, bool: true };

export class Unsynthesisable extends Error {}

let uuids = 0;
/** A new UUID (v4 shape), different each time, so two ids in one request differ. */
export const nextUuid = () => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;

const typesOf = (s: Json): string[] => (Array.isArray(s.type) ? s.type.map(String) : typeof s.type === 'string' ? [s.type] : []);

function isNullable(s: Json): boolean {
  if (typesOf(s).includes('null')) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  if ('const' in s && s.const === null) return true;
  const variants = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : [];
  return variants.some((v) => isNullable(resolve(v)));
}

const isNullOnly = (s: Json) => typesOf(s).length > 0 && typesOf(s).every((t) => t === 'null');

/** A value the schema accepts: its example, its const, its first allowed value, else one made from its type and format. */
export function sample(raw: unknown, o: SampleOptions, depth = 0): unknown {
  const s = resolve(raw);
  if (depth > 16) throw new Unsynthesisable('the schema nests too deep');
  if (o.nulls && isNullable(s)) return null;
  if ('example' in s && s.example !== undefined) return structuredClone(s.example);
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) {
    const values = s.enum.filter((v) => v !== null);
    return values.length ? values[0] : null;
  }
  if (Array.isArray(s.allOf)) return sampleAllOf(s, o, depth);
  const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined)?.map((v) => resolve(v));
  if (variants) {
    // The first real variant for the smaller value, the last one for the fuller.
    const real = variants.filter((v) => !isNullOnly(v));
    const pick = o.all ? real[real.length - 1] : real[0];
    return pick ? sample(pick, o, depth + 1) : null;
  }
  const types = typesOf(s);
  const type = types.find((t) => t !== 'null') ?? (isObj(s.properties) ? 'object' : s.items ? 'array' : types[0]);
  switch (type) {
    case 'object': {
      const props = resolve(s.properties);
      const required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
      const out: Json = {};
      for (const [k, v] of Object.entries(props)) if (o.all || required.has(k)) out[k] = sample(v, o, depth + 1);
      const missing = [...required].filter((k) => !(k in out));
      if (missing.length) throw new Unsynthesisable(`required ${missing.join(', ')} without a schema`);
      return out;
    }
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      const max = typeof s.maxItems === 'number' ? s.maxItems : Infinity;
      const n = Math.min(max, Math.max(min, o.items));
      return Array.from({ length: n }, () => sample(s.items, o, depth + 1));
    }
    case 'string':
      return sampleString(s);
    case 'integer':
    case 'number':
      return sampleNumber(s, type);
    case 'boolean':
      return o.bool;
    case 'null':
      return null;
    case undefined:
    default:
      // No type: the schema accepts anything.
      return 'any';
  }
}

/** allOf: objects are merged, their properties and required lists together; anything else takes its first part. */
function sampleAllOf(s: Json, o: SampleOptions, depth: number): unknown {
  const parts = [{ ...s, allOf: undefined }, ...(s.allOf as unknown[]).map((p) => resolve(p))];
  const objects = parts.filter((p) => isObj(p.properties) || typesOf(p).includes('object') || Array.isArray(p.allOf));
  if (objects.length < 2) return sample((s.allOf as unknown[])[0], o, depth + 1);
  const out: Json = {};
  for (const p of objects) {
    // Each part as an object, though a part may also allow null (`{ "type": ["object", "null"] }`): allOf wants all.
    const v = sample({ ...p, type: 'object' }, o, depth + 1);
    if (isObj(v)) Object.assign(out, v);
  }
  return out;
}

const FORMATS: Record<string, () => string> = {
  uuid: nextUuid,
  email: () => 'ana@example.com',
  date: () => '2026-11-01',
  'date-time': () => '2026-11-01T14:05:00Z',
};

function sampleString(s: Json): string {
  const format = typeof s.format === 'string' ? FORMATS[s.format] : undefined;
  if (format) return format();
  if (typeof s.pattern === 'string') return fromPattern(s.pattern);
  const min = typeof s.minLength === 'number' ? s.minLength : 0;
  const max = typeof s.maxLength === 'number' ? s.maxLength : Infinity;
  return 'text'.padEnd(min, 'x').slice(0, max);
}

function sampleNumber(s: Json, type: string): number {
  const integer = type === 'integer';
  let n = typeof s.minimum === 'number' ? s.minimum
    : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + (integer ? 1 : 0.5)
      : 1;
  if (typeof s.maximum === 'number' && n > s.maximum) n = s.maximum;
  if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) n = s.exclusiveMaximum - (integer ? 1 : 0.5);
  return integer ? Math.ceil(n) : n;
}

/**
 * The shortest string a simple pattern accepts: literals, escapes (`\d`, `\+`), classes (their first character),
 * groups with alternatives (the first), and quantifiers (their least count). Anything else is reported, not guessed.
 */
export function fromPattern(pattern: string): string {
  const src = pattern.replace(/^\^/, '').replace(/(?<!\\)\$$/, '');
  let i = 0;
  const fail = (why: string) => new Unsynthesisable(`pattern ${pattern}: ${why}`);
  const escaped = (c: string | undefined) => {
    if (c === undefined) throw fail('ends in \\');
    if (c === 'd') return '0';
    if (c === 'w') return 'a';
    if (c === 's') return ' ';
    if (/[A-Za-z]/.test(c)) throw fail(`\\${c}`);
    return c;
  };
  const atom = (): string => {
    const c = src[i++]!;
    if (c === '(') {
      if (src[i] === '?') {
        if (src[i + 1] !== ':') throw fail('a lookaround or a named group');
        i += 2;
      }
      const s = alternatives();
      if (src[i++] !== ')') throw fail('an unclosed group');
      return s;
    }
    if (c === '[') {
      if (src[i] === '^') throw fail('a negated class');
      let first: string | undefined;
      while (i < src.length && src[i] !== ']') {
        const ch = src[i++] === '\\' ? escaped(src[i++]) : src[i - 1]!;
        first ??= ch;
      }
      if (src[i++] !== ']' || first === undefined) throw fail('an unclosed class');
      return first;
    }
    if (c === '\\') return escaped(src[i++]);
    if (c === '.') return 'a';
    if ('*+?{'.includes(c)) throw fail('a quantifier with nothing before it');
    return c;
  };
  const least = (): number => {
    const c = src[i];
    if (c === '*' || c === '?') {
      i++;
      return 0;
    }
    if (c === '+') {
      i++;
      return 1;
    }
    if (c === '{') {
      const m = /^\{(\d+)(,\d*)?\}/.exec(src.slice(i));
      if (!m) throw fail('a malformed {n,m}');
      i += m[0].length;
      return Number(m[1]);
    }
    return 1;
  };
  const sequence = (): string => {
    let out = '';
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      const a = atom();
      out += a.repeat(least());
    }
    return out;
  };
  const alternatives = (): string => {
    const first = sequence();
    while (src[i] === '|') {
      i++;
      sequence();
    }
    return first;
  };
  const value = alternatives();
  if (i < src.length) throw fail(`unexpected "${src[i]}"`);
  if (!new RegExp(pattern, 'u').test(value)) throw fail(`made "${value}", which it refuses`);
  return value;
}

// Command lines.

/** One input of a command line, and how the CLI names it when it is missing. */
export interface Part {
  kind: 'arg' | 'query' | 'flag' | 'data';
  name: string;
  required: boolean;
  argv: string[];
  /** For `data`: the field's value in --data. */
  value?: unknown;
  /** What the CLI's "missing …" message says for it. */
  missing: string;
}

export interface Invocation {
  cmd: Command;
  parts: Part[];
  /** More arguments: paging. */
  extra: string[];
  /** The path the request must go to, the arguments in it. */
  path: string;
}

/** `--flag value` as a person types it (`--delta -2` too), or `--flag=value` for text that starts with a dash. */
function valueArgs(flag: string, v: unknown): string[] {
  const s = String(v);
  return s.startsWith('-') && typeof v !== 'number' ? [`--${flag}=${s}`] : [`--${flag}`, s];
}

/** How a field's value goes on the command line as its flag; undefined when only --data can carry it. */
function flagArgs(f: Field, v: unknown): string[] | undefined {
  if (!f.flag || v === null || v === undefined) return undefined;
  if (f.type === 'boolean') return typeof v === 'boolean' ? [v ? `--${f.flag}` : `--no-${f.flag}`] : undefined;
  if (f.type === 'array') {
    if (!Array.isArray(v) || !v.length || v.some((x) => x === null || typeof x === 'object' || String(x).includes(','))) return undefined;
    return v.flatMap((x) => valueArgs(f.flag!, x));
  }
  if (typeof v === 'object') return undefined;
  return valueArgs(f.flag, v);
}

/** A command line for a command: its required input only, or every flag it has (and paging, for a list). */
export function invocation(cmd: Command, op: Operation, every: boolean): Invocation {
  const o = every ? EVERY_INPUT : REQUIRED_INPUT;
  const parts: Part[] = [];
  const params: Record<string, string> = {};
  for (const a of cmd.args) {
    const p = op.params.find((x) => x.in === 'path' && x.name === a.name);
    if (!p) throw new Error(`${op.id}: path parameter ${a.name} is not in the spec`);
    const v = String(sample(p.schema, o));
    params[a.name] = v;
    parts.push({ kind: 'arg', name: a.name, required: true, argv: [v], missing: `<${a.label}>` });
  }
  for (const f of cmd.query) {
    if (!every && !f.required) continue;
    const p = op.params.find((x) => x.in === 'query' && x.name === f.name);
    if (!p) throw new Error(`${op.id}: query parameter ${f.name} is not in the spec`);
    const argv = flagArgs(f, sample(p.schema, o));
    if (!argv) throw new Unsynthesisable(`query parameter ${f.name} cannot go on the command line`);
    parts.push({ kind: 'query', name: f.name, required: Boolean(f.required), argv, missing: f.flag ? `--${f.flag}` : f.name });
  }
  if (cmd.body && op.body) {
    const props = resolve(mergedProperties(op.body.schema));
    for (const f of cmd.body.fields) {
      if (!every && !f.required) continue;
      const v = sample(props[f.name], o);
      const argv = flagArgs(f, v);
      const required = Boolean(f.required);
      if (argv) parts.push({ kind: 'flag', name: f.name, required, argv, missing: `--${f.flag}` });
      else parts.push({ kind: 'data', name: f.name, required, argv: [], value: v, missing: `"${f.name}" (set it in --data)` });
    }
  }
  const extra: string[] = [];
  if (every && cmd.list?.pageToken) {
    extra.push('--page-token', 'page-2');
    if (cmd.list.pageSize) extra.push('--page-size', '2');
  }
  const path = cmd.path.replace(/\{([^}]+)\}/g, (_, name: string) => encodeURIComponent(params[name]!));
  return { cmd, parts, extra, path };
}

/** The properties of an object schema, allOf parts included. */
function mergedProperties(schema: Json): Json {
  const out: Json = { ...resolve(schema.properties) };
  if (Array.isArray(schema.allOf)) for (const p of schema.allOf) Object.assign(out, mergedProperties(resolve(p)));
  return out;
}

/** The command line, without one part (for the checks of a missing input). */
export function argvOf(inv: Invocation, without?: Part): string[] {
  const kept = inv.parts.filter((p) => p !== without);
  const data = Object.fromEntries(kept.filter((p) => p.kind === 'data').map((p) => [p.name, p.value]));
  return [
    ...inv.cmd.words,
    ...kept.filter((p) => p.kind === 'arg').flatMap((p) => p.argv),
    ...kept.filter((p) => p.kind === 'query' || p.kind === 'flag').flatMap((p) => p.argv),
    ...(Object.keys(data).length ? ['--data', JSON.stringify(data)] : []),
    ...inv.extra,
  ];
}

// The checks of a request.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The query string's values as the parameter's schema types them: numbers, booleans, a list for an array. */
function typedQuery(schema: Json, values: string[]): unknown {
  const types = typesOf(schema);
  const one = (raw: string, s: Json): unknown => {
    const t = typesOf(s);
    if (raw === 'null' && t.includes('null')) return null;
    if ((t.includes('integer') || t.includes('number')) && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
    if (t.includes('boolean') && (raw === 'true' || raw === 'false')) return raw === 'true';
    return raw;
  };
  if (types.includes('array')) return values.map((v) => one(v, resolve(schema.items)));
  return values.length === 1 ? one(values[0]!, schema) : values;
}

/** Everything about a request its operation does not accept: an empty list when it is right. */
export function requestProblems(op: Operation, req: SentRequest, expected: { basePath: string; path: string; key: string }): string[] {
  const problems: string[] = [];
  if (req.method !== op.method) problems.push(`method ${req.method}, the operation's is ${op.method}`);

  const url = new URL(req.url);
  if (url.pathname !== expected.basePath + expected.path) problems.push(`path ${url.pathname}, expected ${expected.basePath}${expected.path}`);
  const template = new RegExp(`^${op.path.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/:]+')}$`);
  if (!template.test(url.pathname.slice(expected.basePath.length))) problems.push(`path ${url.pathname} does not match ${op.path}`);
  const verb = /:[a-z][a-zA-Z0-9-]*$/.exec(op.path)?.[0];
  if (verb && !url.pathname.endsWith(verb)) problems.push(`the custom method ${verb} is not at the end of ${url.pathname}`);

  const declared = op.params.filter((p) => p.in === 'query');
  for (const name of new Set(url.searchParams.keys())) {
    const p = declared.find((d) => d.name === name);
    if (!p) {
      problems.push(`query parameter ${name} is not one of ${op.id}'s (${declared.map((d) => d.name).join(', ') || 'none'})`);
      continue;
    }
    const why = invalid(p.at, typedQuery(p.schema, url.searchParams.getAll(name)), `query.${name}`);
    if (why) problems.push(why);
  }
  for (const p of declared) if (p.required && !url.searchParams.has(p.name)) problems.push(`required query parameter ${p.name} not sent`);

  if (req.headers.authorization !== `Bearer ${expected.key}`) problems.push(`authorization is "${req.headers.authorization}", expected Bearer and the key`);
  const idem = op.params.find((p) => p.in === 'header' && p.name.toLowerCase() === 'idempotency-key');
  const sentKey = req.headers['idempotency-key'];
  if (idem && sentKey === undefined) problems.push('no Idempotency-Key, which the operation takes');
  if (!idem && sentKey !== undefined) problems.push('an Idempotency-Key, which the operation does not take');
  if (idem && sentKey !== undefined) {
    if (!UUID.test(sentKey)) problems.push(`Idempotency-Key "${sentKey}" is not a UUID`);
    const why = invalid(idem.at, sentKey, 'Idempotency-Key');
    if (why) problems.push(why);
  }
  for (const p of op.params) {
    if (p.in === 'header' && p.required && req.headers[p.name.toLowerCase()] === undefined) problems.push(`required header ${p.name} not sent`);
  }

  if (req.body !== undefined) {
    if (!op.body) problems.push('a body, which the operation does not take');
    else {
      const why = invalid(op.body.at, req.body, 'body');
      if (why) problems.push(why);
    }
    if (req.headers['content-type'] !== 'application/json') problems.push(`content-type "${req.headers['content-type']}" on a JSON body`);
  } else {
    if (op.body?.required) problems.push('no body, which the operation requires');
    if (req.headers['content-type'] !== undefined) problems.push('a content-type without a body');
  }
  return problems;
}
