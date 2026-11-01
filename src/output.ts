// What a command prints. JSON when the output is a pipe or a file (or --json): the API's answer as it came.
// For people (a terminal, or --human): a list as a table, one record as `key: value` lines; `*_minor` money as a
// decimal with the record's currency, times in local time, yes/no for booleans, `-` for nothing.

import type { ListInfo } from './types.ts';

export interface RenderOptions {
  /** Columns chosen with --columns. */
  columns?: string[];
  /** The list this answer is, from the command table. */
  list?: ListInfo;
  /** The terminal's width. */
  width?: number;
  locale?: string;
  timeZone?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function renderJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function renderHuman(data: unknown, opts: RenderOptions = {}): string {
  if (Array.isArray(data)) return renderTable(data, opts);
  if (isObj(data)) {
    const key = opts.list?.key ?? listKeyOf(data);
    if (key && Array.isArray(data[key])) return renderTable(data[key], opts);
    return renderRecord(unwrap(data), opts);
  }
  if (data === undefined || data === null || data === '') return '';
  return String(data);
}

/** The array of records in an answer like `{ "tickets": [...], "next_page_token": "..." }`. */
export function listKeyOf(data: Record<string, unknown>): string | undefined {
  const keys = Object.keys(data).filter((k) => k !== 'next_page_token');
  const arrays = keys.filter((k) => Array.isArray(data[k]) && (data[k] as unknown[]).every(isObj));
  return arrays.length === 1 && keys.length <= 2 ? arrays[0] : undefined;
}

/** `{ "ticket": {...} }` → the ticket. */
function unwrap(data: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(data);
  return keys.length === 1 && isObj(data[keys[0]!]) ? (data[keys[0]!] as Record<string, unknown>) : data;
}

// Tables.

const NAME_KEYS = ['name', 'first_name', 'last_name', 'customer_name', 'device_name', 'supplier_name', 'title', 'label', 'sku', 'problem', 'brand', 'model', 'kind', 'phone', 'email'];
const STATE_KEYS = ['status', 'state', 'role', 'active'];
const MONEY_FIRST = ['total_minor', 'total_with_tax_minor', 'amount_due_minor', 'amount_minor', 'price_minor', 'balance_minor'];
const TIME_FIRST = ['created_at', 'at', 'due_at'];
const MAX_AUTO_COLUMNS = 9;
const MAX_CELL = 40;

const isMoneyKey = (k: string) => k.endsWith('_minor');
const isTimeKey = (k: string) => /(^at$|_at$|_since$|_until$)/.test(k);
const isHidden = (k: string) => k !== 'id' && (k.endsWith('_id') || k === 'currency' || /token|secret|password/.test(k));

/** Where a column goes when the table picks them: the id, the number, names, states, money, times, the rest. */
function rank(k: string): number {
  if (k === 'id') return 0;
  if (k === 'number') return 1;
  if (NAME_KEYS.includes(k)) return 2 + NAME_KEYS.indexOf(k) / 100;
  if (STATE_KEYS.includes(k)) return 3;
  if (isMoneyKey(k)) return 4 + (MONEY_FIRST.includes(k) ? MONEY_FIRST.indexOf(k) / 100 : 0.5);
  if (isTimeKey(k)) return 5 + (TIME_FIRST.includes(k) ? TIME_FIRST.indexOf(k) / 100 : 0.5);
  return 6;
}

/** The columns a table shows when --columns does not say: the id, then names, states, money and times. */
export function pickColumns(candidates: string[], rows: Record<string, unknown>[]): string[] {
  const scalar = (k: string) => rows.every((r) => r[k] === undefined || r[k] === null || typeof r[k] !== 'object');
  const keys = candidates.filter((k) => !isHidden(k) && scalar(k));
  const ordered = keys.map((k, i) => ({ k, r: rank(k), i })).toSorted((a, b) => a.r - b.r || a.i - b.i).map((x) => x.k);
  const out: string[] = [];
  let money = 0;
  let times = 0;
  for (const k of ordered) {
    if (isMoneyKey(k) && ++money > 2) continue;
    if (isTimeKey(k) && ++times > 1) continue;
    out.push(k);
    if (out.length >= MAX_AUTO_COLUMNS) break;
  }
  return out;
}

export function renderTable(rows: unknown[], opts: RenderOptions = {}): string {
  if (!rows.length) return '(none)';
  if (!rows.every(isObj)) return rows.map((r) => (isObj(r) || Array.isArray(r) ? JSON.stringify(r) : formatScalar(r, '', undefined, opts))).join('\n');
  const records = rows as Record<string, unknown>[];
  const chosen = Boolean(opts.columns?.length);
  let columns: string[];
  if (chosen) columns = opts.columns!;
  else {
    const seen = new Set<string>([...(opts.list?.columns ?? []), ...records.flatMap((r) => Object.keys(r))]);
    columns = pickColumns([...seen].filter((k) => records.some((r) => k in r)), records);
  }

  const cells = records.map((r) => columns.map((c) => clip(cell(get(r, c), c, r, opts))));
  const heads = columns.map(label);
  const widths = columns.map((_, i) => Math.max(heads[i]!.length, ...cells.map((row) => row[i]!.length)));
  // Columns picked here are dropped from the right until the table fits the terminal.
  const width = opts.width ?? 120;
  let n = columns.length;
  if (!chosen) while (n > 1 && widths.slice(0, n).reduce((a, b) => a + b, 0) + 2 * (n - 1) > width) n--;
  const right = columns.map((c) => isMoneyKey(c) || records.every((r) => typeof get(r, c) === 'number' || get(r, c) == null));
  const line = (row: string[]) => row.slice(0, n).map((v, i) => (right[i] ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(heads), ...cells.map(line)].join('\n');
}

function get(r: Record<string, unknown>, path: string): unknown {
  let v: unknown = r;
  for (const part of path.split('.')) v = isObj(v) ? v[part] : undefined;
  return v;
}

function cell(v: unknown, key: string, row: Record<string, unknown>, opts: RenderOptions): string {
  if (Array.isArray(v)) return v.every((x) => !isObj(x) && !Array.isArray(x)) ? v.join(', ') || '-' : JSON.stringify(v);
  if (isObj(v)) return JSON.stringify(v);
  return formatScalar(v, key.split('.').pop()!, typeof row.currency === 'string' ? row.currency : undefined, opts);
}

const clip = (s: string) => {
  const one = s.replace(/\s*\n\s*/g, ' ');
  return one.length > MAX_CELL ? `${one.slice(0, MAX_CELL - 1)}…` : one;
};

/** `price_minor` → `PRICE`, `first_name` → `FIRST NAME`. */
function label(key: string): string {
  return key.replace(/_minor$/, '').replace(/[_.]/g, ' ').toUpperCase();
}

// Records.

export function renderRecord(obj: Record<string, unknown>, opts: RenderOptions = {}): string {
  const lines = recordLines(obj, 0, undefined, opts);
  return lines.length ? lines.join('\n') : '(empty)';
}

function recordLines(obj: Record<string, unknown>, indent: number, inherited: string | undefined, opts: RenderOptions): string[] {
  const currency = typeof obj.currency === 'string' ? obj.currency : inherited;
  const pad = ' '.repeat(indent);
  const names = Object.keys(obj).map((k) => k.replace(/_minor$/, ''));
  const w = Math.max(0, ...names.map((n) => n.length));
  const lines: string[] = [];
  for (const [key, v] of Object.entries(obj)) {
    const name = key.replace(/_minor$/, '');
    if (isObj(v) && Object.keys(v).length) {
      lines.push(`${pad}${name}:`);
      lines.push(...recordLines(v, indent + 2, currency, opts));
    } else if (Array.isArray(v) && v.length && v.some((x) => isObj(x) || Array.isArray(x))) {
      lines.push(`${pad}${name}:`);
      for (const item of v) {
        if (isObj(item)) {
          const sub = recordLines(item, indent + 4, currency, opts);
          if (sub.length) sub[0] = `${pad}  - ${sub[0]!.slice(indent + 4)}`;
          lines.push(...sub);
        } else lines.push(`${pad}  - ${JSON.stringify(item)}`);
      }
    } else {
      const text = Array.isArray(v) ? (v.length ? v.map((x) => formatScalar(x, '', currency, opts)).join(', ') : '-')
        : isObj(v) ? '-' : formatScalar(v, key, currency, opts);
      const [first, ...more] = text.split('\n');
      lines.push(`${pad}${`${name}:`.padEnd(w + 1)}  ${first}`.trimEnd());
      for (const m of more) lines.push(`${pad}${' '.repeat(w + 3)}${m}`);
    }
  }
  return lines;
}

// Values.

export function formatScalar(v: unknown, key: string, currency: string | undefined, opts: RenderOptions = {}): string {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number' && isMoneyKey(key) && Number.isInteger(v)) return formatMoney(v, currency, opts.locale);
  if (typeof v === 'string' && looksLikeTime(v)) return formatTime(v, opts.timeZone);
  return String(v);
}

/** 2176 → `21.76 USD`; the currency decides the decimals (JPY has none). Without one: `21.76`. */
export function formatMoney(minor: number, currency?: string, locale?: string): string {
  let digits = 2;
  if (currency) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      // not a currency code Intl knows: two decimals
    }
  }
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
  return currency ? `${n} ${currency}` : n;
}

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function looksLikeTime(s: string): boolean {
  return TIME.test(s) && !Number.isNaN(Date.parse(s));
}

/** An ISO time in UTC → `2026-11-01 14:05` in the local time zone (or `timeZone`). */
export function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
}
