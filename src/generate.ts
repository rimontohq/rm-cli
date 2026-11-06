// The API's OpenAPI document → the command table (src/types.ts). Pure: scripts/generate.ts writes the result to
// src/generated/commands.ts, and the tests run it on the checked-in spec and on small documents of their own.

import { BUILTIN_WORDS, argLabel, kebab, splitPath, standardVerb, type PathParts } from './naming.ts';
import type { Area, Arg, Command, CommandTable, Field, FieldType, ListInfo, Method } from './types.ts';

type Json = Record<string, unknown>;
type Schema = Json;

interface OpenApiDoc {
  info?: { version?: string };
  tags?: { name: string; description?: string }[];
  paths?: Record<string, Json>;
  security?: Record<string, string[]>[];
  [k: string]: unknown;
}

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Flags every command has (src/args.ts), so a field never takes their names. */
const GLOBAL_FLAGS = ['help', 'version', 'profile', 'api-url', 'header', 'json', 'human', 'verbose', 'timeout'];

/** The security scheme that stands for an API key (`rimonto_sk_…`). */
const API_KEY_SCHEME = 'apiKey';

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export function generate(doc: OpenApiDoc): CommandTable {
  const resolve = resolver(doc);
  const ops: Omit<Command, 'words'>[] = [];
  const candidatesOf = new Map<string, string[][]>();
  const custom = new Set<string>();

  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const item = resolve(rawItem);
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (!isObj(op)) continue;
      const operationId = typeof op.operationId === 'string' ? op.operationId : `${method.toLowerCase()} ${path}`;
      const parts = splitPath(path);
      const params = mergeParams(item.parameters, op.parameters, resolve);

      const args: Arg[] = parts.params.map((p) => {
        const spec = params.find((x) => x.in === 'path' && x.name === p.name);
        const schema = resolve(spec?.schema);
        return compact({ name: p.name, label: argLabel(p, parts), format: str(schema.format), description: str(spec?.description) ?? str(schema.description) });
      });

      const response = successSchema(op, resolve);
      const listKey = method === 'GET' && !parts.endsWithParam && !parts.verb ? findListKey(response, resolve) : undefined;

      const queryParams = params.filter((p) => p.in === 'query');
      let list: ListInfo | undefined;
      if (listKey) {
        const itemSchema = merged(resolve(resolve(resolve(response.properties)[listKey]).items), resolve);
        list = compact({
          key: listKey,
          pageToken: queryParams.some((p) => p.name === 'page_token') ? 'page_token' : undefined,
          pageSize: queryParams.some((p) => p.name === 'max_page_size') ? 'max_page_size' : undefined,
          columns: Object.entries(resolve(itemSchema.properties))
            .filter(([, s]) => isScalar(typeOf(resolve(s), resolve).type))
            .map(([k]) => k),
        });
      }

      const idemParam = params.find((p) => p.in === 'header' && String(p.name).toLowerCase() === 'idempotency-key');
      const idempotency = idemParam ? (idemParam.required ? 'required' : 'optional') : undefined;

      const taken = new Set<string>(GLOBAL_FLAGS);
      taken.add('data');
      if (idempotency) taken.add('idempotency-key');
      if (list) for (const f of ['all', 'limit', 'page-size', 'page-token', 'columns']) taken.add(f);

      const query: Field[] = [];
      for (const p of queryParams) {
        if (list && (p.name === list.pageToken || p.name === list.pageSize)) continue;
        const field = toField(String(p.name), resolve(p.schema), Boolean(p.required), resolve, str(p.description));
        query.push(withFlag(field, taken, 'query-'));
      }

      let body: Command['body'];
      const rb = resolve(op.requestBody);
      const content = resolve(rb.content);
      if (Object.keys(content).length) {
        const schema = merged(resolve(resolve(content['application/json']).schema), resolve);
        const props = resolve(schema.properties);
        const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
        const fields = Object.entries(props).map(([name, s]) =>
          withFlag(toField(name, resolve(s), required.has(name), resolve), taken));
        const isObject = schema.type === 'object' || Object.keys(props).length > 0;
        body = { required: Boolean(rb.required), fields, open: !isObject || schema.additionalProperties === true || isObj(schema.additionalProperties) };
      }

      const security = (Array.isArray(op.security) ? op.security : doc.security ?? []) as Record<string, unknown>[];
      const auth = security.length > 0 && !security.some((r) => Object.keys(r).length === 0);
      const apiKey = !auth || security.some((r) => API_KEY_SCHEME in r);

      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];
      ops.push(compact({
        operationId,
        method,
        path,
        area: tags[0] ?? 'Other',
        summary: str(op.summary),
        description: str(op.description),
        args,
        query,
        body,
        idempotency,
        apiKey,
        auth,
        list,
      }));
      candidatesOf.set(operationId, candidates(method, parts, Boolean(list), operationId));
      if (parts.verb) custom.add(operationId);
    }
  }

  // Standard methods name themselves first, then the longer names (groups before a leaf that would shadow them).
  const order = ops.toSorted((a, b) =>
    Number(custom.has(a.operationId)) - Number(custom.has(b.operationId))
    || candidatesOf.get(b.operationId)![0]!.length - candidatesOf.get(a.operationId)![0]!.length
    || a.path.localeCompare(b.path)
    || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
  const assigned: string[][] = [];
  const wordsOf = new Map<string, string[]>();
  for (const op of order) {
    const words = candidatesOf.get(op.operationId)!.find((c) => fits(c, assigned));
    if (!words) throw new Error(`No unique command for ${op.method} ${op.path} (${op.operationId})`);
    assigned.push(words);
    wordsOf.set(op.operationId, words);
  }

  return {
    apiVersion: str(doc.info?.version) ?? '0.0.0',
    areas: areasOf(doc, ops),
    commands: ops.map((op) => ({ words: wordsOf.get(op.operationId)!, ...op })),
  };
}

/** The names a command may take, best first. The operationId ones exist so that a name is always free. */
export function candidates(method: Method, parts: PathParts, isList: boolean, operationId: string): string[][] {
  const out: string[][] = [];
  const verb = standardVerb(method, parts, isList);
  const singleton = method === 'GET' && !isList && !parts.verb && parts.params.length === 0 && parts.nouns.length === 1;
  if (singleton) out.push([parts.nouns[0]!]);
  if (verb && parts.nouns.length) out.push([...parts.nouns, verb]);
  const id = kebab(operationId);
  if (parts.nouns.length) out.push([...parts.nouns, id]);
  out.push([id]);
  for (let n = 2; n < 100; n++) out.push([`${id}-${n}`]);
  return out;
}

function fits(words: string[], assigned: string[][]): boolean {
  if ((BUILTIN_WORDS as readonly string[]).includes(words[0]!)) return false;
  return !assigned.some((a) => startsWith(a, words) || startsWith(words, a));
}

/** Whether `a` starts with all of `b` (equal included). */
function startsWith(a: string[], b: string[]): boolean {
  return b.length <= a.length && b.every((w, i) => a[i] === w);
}

function areasOf(doc: OpenApiDoc, ops: Omit<Command, 'words'>[]): Area[] {
  const used = new Set(ops.map((o) => o.area));
  const areas: Area[] = [];
  for (const t of doc.tags ?? []) if (used.has(t.name)) areas.push(compact({ name: t.name, description: str(t.description) }));
  for (const o of ops) if (!areas.some((a) => a.name === o.area)) areas.push({ name: o.area });
  return areas;
}

function withFlag(field: Field, taken: Set<string>, prefix?: string): Field {
  const flaggable = isScalar(field.type) || (field.type === 'array' && isScalar(field.items));
  if (!flaggable) return field;
  let flag = kebab(field.name);
  if (taken.has(flag) && prefix) flag = `${prefix}${flag}`;
  if (!flag || taken.has(flag) || (field.type === 'boolean' && taken.has(`no-${flag}`))) return field;
  taken.add(flag);
  if (field.type === 'boolean') taken.add(`no-${flag}`);
  return { ...field, flag };
}

function toField(name: string, schema: Schema, required: boolean, resolve: Resolver, description?: string): Field {
  const t = typeOf(schema, resolve);
  return compact({
    name,
    type: t.type,
    items: t.items,
    enum: t.enum,
    nullable: t.nullable || undefined,
    required: required || undefined,
    format: str(schema.format) ?? t.format,
    default: schema.default,
    example: ['string', 'number', 'boolean'].includes(typeof schema.example) ? schema.example : undefined,
    description: description ?? str(schema.description),
  }) as Field;
}

interface TypeInfo {
  type: FieldType;
  items?: FieldType;
  enum?: (string | number | boolean)[];
  nullable?: true;
  format?: string;
}

function typeOf(raw: Schema, resolve: Resolver): TypeInfo {
  const s = resolve(raw);
  let nullable = false;
  let enumValues: (string | number | boolean)[] | undefined;
  if (Array.isArray(s.enum)) {
    nullable = s.enum.includes(null);
    enumValues = s.enum.filter((v): v is string | number | boolean => v !== null && typeof v !== 'object');
  } else if ('const' in s && s.const !== null && typeof s.const !== 'object') {
    enumValues = [s.const as string | number | boolean];
  }

  const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined) as Schema[] | undefined;
  if (variants) {
    const infos = variants.map((v) => typeOf(resolve(v), resolve));
    const real = infos.filter((i) => !(i.type === 'any' && i.nullable && !i.enum));
    const types = [...new Set(real.map((i) => i.type))];
    const out: TypeInfo = { type: types.length === 1 ? types[0]! : 'any' };
    if (infos.some((i) => i.nullable)) out.nullable = true;
    if (real.length && real.every((i) => i.enum)) out.enum = [...new Set(real.flatMap((i) => i.enum!))];
    if (out.type === 'array' && real.every((i) => i.items === real[0]!.items)) out.items = real[0]!.items;
    const formats = [...new Set(real.map((i) => i.format).filter(Boolean))];
    if (formats.length === 1) out.format = formats[0];
    return out;
  }
  if (Array.isArray(s.allOf)) return typeOf(merged(s, resolve), resolve);

  const types = Array.isArray(s.type) ? s.type.map(String) : typeof s.type === 'string' ? [s.type] : [];
  if (types.includes('null')) nullable = true;
  const real = types.filter((t) => t !== 'null');
  let type: FieldType;
  if (real.length === 1 && isFieldType(real[0]!)) type = real[0];
  else if (real.length === 0 && enumValues?.length) type = inferType(enumValues);
  else if (real.length === 0 && isObj(s.properties)) type = 'object';
  else if (real.length === 0 && s.items) type = 'array';
  else if (real.length === 0 && types.includes('null')) return { type: 'any', nullable: true };
  else type = 'any';

  const out: TypeInfo = { type };
  if (type === 'array') {
    // An array's allowed values and format are its items'.
    const items = typeOf(resolve(s.items), resolve);
    out.items = items.type;
    if (!enumValues?.length && items.enum) enumValues = items.enum;
    const format = str(resolve(s.items).format);
    if (format) out.format = format;
  }
  if (enumValues?.length) out.enum = enumValues;
  if (nullable) out.nullable = true;
  return out;
}

function inferType(values: (string | number | boolean)[]): FieldType {
  if (values.every((v) => typeof v === 'string')) return 'string';
  if (values.every((v) => typeof v === 'boolean')) return 'boolean';
  if (values.every((v) => Number.isInteger(v))) return 'integer';
  if (values.every((v) => typeof v === 'number')) return 'number';
  return 'any';
}

const isFieldType = (t: string): t is FieldType => ['string', 'integer', 'number', 'boolean', 'object', 'array'].includes(t);
const isScalar = (t: FieldType | undefined): boolean => t === 'string' || t === 'integer' || t === 'number' || t === 'boolean';

/** A schema with its allOf parts folded in (their properties and required lists). */
function merged(raw: Schema, resolve: Resolver): Schema {
  const s = resolve(raw);
  if (!Array.isArray(s.allOf)) return s;
  const parts = [s, ...s.allOf.map((p) => merged(resolve(p), resolve))];
  const properties: Json = {};
  const required: string[] = [];
  for (const p of parts) {
    Object.assign(properties, resolve(p.properties));
    if (Array.isArray(p.required)) required.push(...p.required.map(String));
  }
  const { allOf: _allOf, ...rest } = s;
  return { ...rest, type: 'object', properties, required };
}

function successSchema(op: Json, resolve: Resolver): Schema {
  const responses = resolve(op.responses);
  const code = ['200', '201', ...Object.keys(responses).filter((c) => /^2\d\d$/.test(c))].find((c) => c in responses);
  if (!code) return {};
  const content = resolve(resolve(responses[code]).content);
  return merged(resolve(resolve(content['application/json']).schema), resolve);
}

/** The array of records in a list's response: its only array of objects, or the one next to `next_page_token`. */
function findListKey(schema: Schema, resolve: Resolver): string | undefined {
  const props = resolve(schema.properties);
  const arrays = Object.entries(props).filter(([, s]) => {
    const p = resolve(s);
    if (typeOf(p, resolve).type !== 'array') return false;
    const items = merged(resolve(p.items), resolve);
    return typeOf(items, resolve).type === 'object' || isObj(items.properties);
  });
  if (arrays.length === 1 || (arrays.length > 1 && 'next_page_token' in props)) return arrays[0]![0];
  return undefined;
}

interface Param { name: string; in: string; required?: boolean; schema?: unknown; description?: unknown }

function mergeParams(pathLevel: unknown, opLevel: unknown, resolve: Resolver): Param[] {
  const out: Param[] = [];
  for (const list of [pathLevel, opLevel]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolve(raw) as unknown as Param;
      const i = out.findIndex((x) => x.name === p.name && x.in === p.in);
      if (i >= 0) out[i] = p;
      else out.push(p);
    }
  }
  return out;
}

type Resolver = (v: unknown) => Json;

/** Follows local `$ref`s (`#/components/schemas/Ticket`); anything else becomes an empty object. */
function resolver(doc: OpenApiDoc): Resolver {
  const resolve = (v: unknown, depth = 0): Json => {
    if (!isObj(v)) return {};
    if (typeof v.$ref !== 'string' || depth > 32) return v;
    if (!v.$ref.startsWith('#/')) return {};
    let target: unknown = doc;
    for (const key of v.$ref.slice(2).split('/').map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      target = isObj(target) ? target[key] : undefined;
    }
    return resolve(target, depth + 1);
  };
  return (v) => resolve(v);
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The object without its undefined values, so the generated file stays small and stable. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** The generated module's text: src/generated/commands.ts. */
export function renderModule(table: CommandTable): string {
  return [
    '// Generated by `npm run generate` from spec/openapi.json. Do not edit: change the spec (`npm run spec`) and generate.',
    "import type { CommandTable } from '../types.ts';",
    '',
    `export const TABLE: CommandTable = ${JSON.stringify(table, null, 2)};`,
    '',
  ].join('\n');
}
