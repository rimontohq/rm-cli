// Help, built from the command table: the areas (the API's tags), a group's commands, one command's flags.

import { DATA_FLAG, GLOBAL_FLAGS, commandFlags, usage, type FlagSpec } from './args.ts';
import { kebab } from './naming.ts';
import type { Builtin } from './tree.ts';
import type { Command, CommandTable, Field } from './types.ts';
import { VERSION } from './version.ts';

const WIDTH = 100;
const PERSON = '*';
const PERSON_NOTE = `${PERSON} needs a person's own sign-in: an API key cannot run it`;

export function rootHelp(table: CommandTable): string {
  const areaRows = table.areas.map((a) => {
    const groups: string[] = [];
    for (const c of table.commands) {
      if (c.area !== a.name) continue;
      const g = c.words.length > 1 ? c.words.slice(0, -1).join(' ') : c.words[0]!;
      if (!groups.includes(g)) groups.push(g);
    }
    return [a.name, groups.join(', ')] as [string, string];
  });
  return [
    `rimonto ${VERSION}: your repair shop's API from a terminal.`,
    '',
    'Usage',
    '  rimonto <command> [arguments] [flags]',
    '',
    'Start here',
    ...rows([
      ['login', 'Sign in with an API key from the developer portal'],
      ['whoami', 'What your key acts as: company, role, stores'],
      ['auth status', 'Each profile\'s API address and key, and what it acts as'],
      ['logout', 'Forget a profile\'s key'],
      ['api <METHOD> <path>', 'Call any API path, like rimonto api GET /whoami'],
    ]),
    '',
    'Areas and their commands',
    ...rows(areaRows),
    '',
    'More help',
    '  rimonto <command> --help         a group\'s commands (rimonto tickets --help) or one command\'s flags',
    '  rimonto help <area>              an area\'s commands (rimonto help repairs)',
    '',
    'Flags for every command',
    ...flagRows(GLOBAL_FLAGS),
    '',
    'Output is a table or a record in a terminal and JSON in a pipe. Exit codes: 0 done, 1 the API refused,',
    '2 the API could not be reached, 64 a usage error.',
    `API reference: https://developers.rimonto.app (this build knows API ${table.apiVersion}).`,
  ].join('\n');
}

/**
 * A group's commands (`rimonto tickets --help`), or an area's (`rimonto help repairs`). `footer: false` leaves out
 * the closing lines, for a list that another one follows; `person` marks commands needing a person in either.
 */
export function listHelp(title: string, commands: Command[], table: CommandTable, byArea: boolean, footer = true, person = commands.some((c) => !c.apiKey)): string {
  const out = [title, ''];
  const sections = byArea
    ? table.areas.map((a) => [a.name, commands.filter((c) => c.area === a.name)] as const).filter(([, cs]) => cs.length)
    : [['', commands] as const];
  for (const [area, cs] of sections) {
    if (area && sections.length > 1) out.push(area);
    out.push(...rows(cs.map((c) => [
      [...c.words, ...c.args.map((a) => `<${a.label}>`)].join(' ') + (c.apiKey ? '' : ` ${PERSON}`),
      c.summary ?? '',
    ])));
    if (area && sections.length > 1) out.push('');
  }
  if (!footer) return out.join('\n').trimEnd();
  if (out[out.length - 1] !== '') out.push('');
  if (person) out.push(PERSON_NOTE);
  out.push('Run `rimonto <command> --help` for a command\'s flags.');
  return out.join('\n');
}

export function areaByName(table: CommandTable, name: string): string | undefined {
  const k = kebab(name);
  return table.areas.find((a) => kebab(a.name) === k)?.name;
}

export function commandHelp(cmd: Command): string {
  const out: string[] = [];
  out.push(cmd.summary ?? cmd.words.join(' '), '', 'Usage', `  ${usage(cmd)}`, '');
  if (cmd.description) out.push(...wrap(cmd.description, WIDTH, '  ').map((l) => l.trimEnd()), '');
  if (!cmd.apiKey) out.push("Needs a person's own sign-in: an API key cannot run this command.", '');

  if (cmd.args.length) {
    out.push('Arguments');
    out.push(...rows(cmd.args.map((a) => [`<${a.label}>`, [a.format === 'uuid' ? 'An id (UUID)' : a.format, a.description].filter(Boolean).join('. ')])));
    out.push('');
  }
  const flags = commandFlags(cmd).filter((f) => !f.negates);
  const fieldFlags = flags.filter((f) => f.field);
  const otherFlags = flags.filter((f) => !f.field);
  if (fieldFlags.length) {
    out.push('Flags');
    out.push(...flagRows(fieldFlags));
    out.push('');
  }
  const dataOnly = (cmd.body?.fields ?? []).filter((f) => !f.flag);
  if (dataOnly.length) {
    out.push('Fields set through --data');
    out.push(...rows(dataOnly.map((f) => [f.name, fieldNote(f)])));
    out.push('');
  }
  if (otherFlags.length) {
    out.push(otherFlags.includes(DATA_FLAG) || cmd.idempotency ? 'Request' : 'Listing');
    out.push(...flagRows(otherFlags));
    out.push('');
  }
  out.push('Example', `  ${example(cmd)}`, '');
  const idem = cmd.idempotency
    ? ' It sends a new Idempotency-Key and retries with the same one after a network error.'
    : cmd.method === 'GET' ? '' : ' It is sent once: no automatic retries.';
  out.push(`API: ${cmd.method} ${cmd.path} (${cmd.operationId}).${idem}`);
  out.push('Flags for every command: rimonto --help');
  return out.join('\n');
}

export function builtinHelp(b: Builtin): string {
  switch (b) {
    case 'login':
      return [
        'Sign in with an API key',
        '',
        'Usage',
        '  rimonto login [--with-key] [--profile <name>] [--api-url <url>] [-H "Name: value"]',
        '',
        'Asks for the key with hidden input, checks it with GET /whoami, shows what it acts as and keeps it in the',
        'profile (config.json in your config folder, readable by you only). An owner makes keys in the developer',
        'portal, https://developers.rimonto.app, under API keys.',
        '',
        'Flags',
        ...rows([
          ['--with-key', 'Read the key from stdin instead of asking: rimonto login --with-key < key.txt'],
          ['--profile <name>', 'Keep it in this profile (default: "default")'],
          ['--api-url <url>', 'Keep this API address in the profile too'],
          ['-H "Name: value"', 'Keep these extra headers in the profile too (for a gateway in front of the API)'],
        ]),
        '',
        'RIMONTO_API_KEY, when set, is used instead of any stored key, with no login.',
        'Signing in with a browser, as a person, comes in a later version.',
      ].join('\n');
    case 'logout':
      return [
        'Forget a profile\'s key',
        '',
        'Usage',
        '  rimonto logout [--profile <name>]',
        '',
        'Removes the key from the config file. The key itself keeps working until an owner revokes it in the',
        'developer portal (API keys).',
      ].join('\n');
    case 'auth status':
      return [
        'Each profile\'s API address and key, and what the key acts as',
        '',
        'Usage',
        '  rimonto auth status [--json]',
        '',
        'Checks every stored key with GET /whoami. Exits with 1 when the profile in use has no working key.',
      ].join('\n');
    case 'api':
      return [
        'Call any API path, with the same sign-in, retries and output as the other commands',
        '',
        'Usage',
        '  rimonto api <METHOD> <path> [flags]',
        '  rimonto api <path>                     a GET',
        '',
        'Flags',
        ...rows([
          ['-d, --data <json>', 'The request body: JSON, @file.json, or - for stdin'],
          ['-q, --query key=value', 'A query parameter; repeat for more (or put them in the path)'],
          ['--idempotency-key <key>', 'Send this key (commands that take one get a new key otherwise)'],
          ['--paginate', 'For a list: follow next_page_token to the last page'],
          ['--columns <a,b,c>', 'The table\'s columns (human output)'],
        ]),
        '',
        'Examples',
        '  rimonto api GET /whoami',
        '  rimonto api POST /customers -d \'{"store_id": "…", "first_name": "Ana"}\'',
        '  rimonto api /tickets -q status=ready --paginate',
      ].join('\n');
    case 'help':
      return 'Usage\n  rimonto help [<command> | <area>]';
  }
}

function fieldNote(f: Field): string {
  const t = f.type === 'array' ? `array of ${f.items === 'object' ? 'objects' : `${f.items ?? 'values'}s`}` : f.type;
  const bits = [f.required ? `${t}, required` : t];
  if (f.enum) bits.push(`one of: ${f.enum.join(', ')}`);
  if (f.description) bits.push(f.description);
  return bits.join('. ');
}

function flagRows(flags: FlagSpec[]): string[] {
  return rows(flags.map((f) => {
    const value = f.value?.startsWith('"') ? f.value : `<${f.value ?? 'value'}>`;
    const name = `${f.short ? `-${f.short}, ` : ''}--${f.name}${f.type === 'string' ? ` ${value}` : ''}`;
    const negatable = f.field?.type === 'boolean' ? ` / --no-${f.name}` : '';
    const field = f.field;
    const bits: string[] = [];
    if (field) {
      if (field.required) bits.push('Required');
      if (field.enum) bits.push(`One of: ${field.enum.join(', ')}`);
      if (field.type === 'array') bits.push(field.enum || field.format === 'uuid' || field.items === 'integer' ? 'Repeat it or separate with commas' : 'Repeat for more');
      if (field.name.endsWith('_minor')) bits.push('Money in minor units (2500 for 25.00)');
      if (field.default !== undefined && field.default !== '' && typeof field.default !== 'object') bits.push(`Default: ${String(field.default)}`);
      if (field.nullable && field.type !== 'string' && field.type !== 'boolean') bits.push('null clears it');
    }
    if (f.help) bits.push(f.help);
    return [name + negatable, bits.join('. ')];
  }));
}

/** Two columns: the left one padded, the right one wrapped. */
function rows(items: [string, string][]): string[] {
  if (!items.length) return [];
  const w = Math.min(Math.max(...items.map(([l]) => l.length)), 40);
  const out: string[] = [];
  for (const [left, right] of items) {
    const text = right.replace(/\s+/g, ' ').trim();
    if (left.length > w) {
      out.push(`  ${left}`);
      if (text) out.push(...wrap(text, WIDTH, ' '.repeat(w + 4)));
      continue;
    }
    const wrapped = text ? wrap(text, WIDTH, ' '.repeat(w + 4)) : [''];
    out.push(`  ${left.padEnd(w)}  ${wrapped[0]!.trimStart()}`.trimEnd(), ...wrapped.slice(1));
  }
  return out;
}

export function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    let line = indent;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.length + word.length + 1 > width && line.trim()) {
        out.push(line.trimEnd());
        line = indent;
      }
      line += (line.trim() ? ' ' : '') + word;
    }
    if (line.trim()) out.push(line);
  }
  return out;
}

/** An example command line: the arguments and the required flags, with sample values. */
export function example(cmd: Command): string {
  const parts = ['rimonto', ...cmd.words, ...cmd.args.map((a) => `<${a.label}>`)];
  const fields = [...cmd.query, ...(cmd.body?.fields ?? [])];
  let flagged = fields.filter((f) => f.required && f.flag);
  if (!flagged.length) flagged = fields.filter((f) => f.flag && f.type !== 'array').slice(0, 1);
  for (const f of flagged) parts.push(f.type === 'boolean' ? `--${f.flag}` : `--${f.flag} ${sample(f)}`);
  const inData = (cmd.body?.fields ?? []).filter((f) => f.required && !f.flag);
  if (inData.length) parts.push(`--data '${JSON.stringify(Object.fromEntries(inData.map((f) => [f.name, f.type === 'array' ? [] : {}])))}'`);
  if (cmd.list?.pageToken) parts.push('--limit 20');
  return parts.join(' ');
}

function sample(f: Field): string {
  if (f.example !== undefined && typeof f.example !== 'object') return quote(String(f.example));
  if (f.enum?.length) return quote(String(f.enum[0]));
  if (f.type === 'integer') return f.name.endsWith('_minor') ? '2500' : '1';
  if (f.type === 'number') return '1';
  if (f.format === 'email') return 'ana@example.com';
  return `<${kebab(f.name)}>`;
}

const quote = (s: string) => (/^[\w.@:/-]+$/.test(s) ? s : `'${s}'`);
