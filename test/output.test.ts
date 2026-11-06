import { describe, expect, it } from 'vitest';
import { formatMoney, formatScalar, formatTime, pickColumns, renderHuman, renderJson, renderRecord, renderTable } from '../src/output.ts';

const opts = { locale: 'en-US', timeZone: 'UTC', width: 200 };

describe('money and times', () => {
  it('shows minor units as a decimal in the currency', () => {
    expect(formatMoney(2176, 'USD', 'en-US')).toBe('21.76 USD');
    expect(formatMoney(123456, 'EUR', 'en-US')).toBe('1,234.56 EUR');
    expect(formatMoney(500, 'JPY', 'en-US')).toBe('500 JPY');
    expect(formatMoney(-250, 'GBP', 'en-US')).toBe('-2.50 GBP');
    expect(formatMoney(2176, undefined, 'en-US')).toBe('21.76');
  });

  it('shows ISO times in the local time zone', () => {
    expect(formatTime('2026-11-01T14:05:09.123Z', 'UTC')).toBe('2026-11-01 14:05');
    expect(formatTime('2026-11-01T14:05:09Z', 'America/New_York')).toBe('2026-11-01 09:05');
  });
});

describe('tables', () => {
  const tickets = [
    { id: 'a1', company_id: 'c', store_id: 's', number: 'T-2041', problem: 'Screen', status: 'ready', currency: 'USD', deposit_minor: 0, total_minor: 12900, created_at: '2026-11-01T09:00:00Z', checks: [{ label: 'x' }], tech_note: 'line one\nline two' },
    { id: 'b2', company_id: 'c', store_id: 's', number: 'T-2042', problem: 'Battery', status: 'new', currency: 'EUR', deposit_minor: 1000, total_minor: 8900, created_at: '2026-11-01T10:30:00Z', checks: [], tech_note: '' },
  ];

  it('picks number, status, who, what, one money, one date, then the rest, and the id last; foreign ids hidden', () => {
    expect(pickColumns(Object.keys(tickets[0]!), tickets)).toEqual(['number', 'status', 'total_minor', 'created_at', 'problem', 'tech_note', 'id']);
  });

  it('aligns columns, formats money with each row\'s currency, and right-aligns numbers', () => {
    expect(renderTable(tickets, opts)).toBe([
      'NUMBER  STATUS       TOTAL  CREATED AT        PROBLEM  TECH NOTE          ID',
      'T-2041  ready   129.00 USD  2026-11-01 09:00  Screen   line one line two  a1',
      'T-2042  new      89.00 EUR  2026-11-01 10:30  Battery  -                  b2',
    ].join('\n'));
  });

  it('shows the columns asked for, nested ones with dots', () => {
    const rows = [{ id: 'a', customer: { name: 'Ana' }, tags: ['vip', 'b2b'] }];
    expect(renderTable(rows, { ...opts, columns: ['customer.name', 'tags'] })).toBe('CUSTOMER NAME  TAGS\nAna            vip, b2b');
  });

  it('says so when a list is empty', () => {
    expect(renderTable([], opts)).toBe('(none)');
  });

  it('renders a list answer as its table', () => {
    expect(renderHuman({ tickets: [{ id: 'x', status: 'new' }], next_page_token: 't' }, opts)).toBe('STATUS  ID\nnew     x');
  });
});

const heads = (lines: string[]) => lines[0]!.split(/ {2,}/);

describe('fitting a table to the terminal', () => {
  // As GET /tickets answers: the API's own fields, and the money and names it adds.
  const ready = [
    ['943d8f26-1609-527c-a4cc-587c5876836c', 'T-2039', 'Omar Haddad', 'Samsung Galaxy A54', 'Cracked screen', 8601],
    ['22e02533-09fa-571d-aef9-94f6457a88c6', 'T-2038', 'Chen Wei', 'Apple iPad Air 5', 'Battery', 7512],
    ['3e5cd3e8-cd9f-54de-8a50-3736a7ea5616', 'T-2031', 'Bartholomew Featherstonehaugh', 'Apple iPhone 14 Pro Max', 'Water damage', 16222],
  ].map(([id, number, customer, device, problem, due]) => ({
    id, company_id: 'c', store_id: 's', number, customer_id: 'u', customer_name: customer, device_name: device, problem, status: 'ready',
    currency: 'USD', amount_due_minor: due, total_with_tax_minor: due, due_at: '2026-11-01T01:42:00Z', due_all_day: true, created_at: '2026-10-30T09:00:00Z',
  }));
  const table = (width: number) => renderTable(ready, { ...opts, width }).split('\n');

  it('at 120 columns: everything it picked, the longest free text shortened with …, the id whole and last', () => {
    expect(table(120)).toEqual([
      'NUMBER  STATUS  CUSTOMER NAME  DEVICE NAME   AMOUNT DUE  DUE AT      PROBLEM        ID',
      'T-2039  ready   Omar Haddad    Samsung Gal…   86.01 USD  2026-11-01  Cracked scre…  943d8f26-1609-527c-a4cc-587c5876836c',
      'T-2038  ready   Chen Wei       Apple iPad …   75.12 USD  2026-11-01  Battery        22e02533-09fa-571d-aef9-94f6457a88c6',
      'T-2031  ready   Bartholomew …  Apple iPhon…  162.22 USD  2026-11-01  Water damage   3e5cd3e8-cd9f-54de-8a50-3736a7ea5616',
    ]);
  });

  it('at 80 columns: drops the last columns once free text is as short as it goes; the rest grow back', () => {
    expect(table(80)).toEqual([
      'NUMBER  STATUS  CUSTOMER NAME               ID',
      'T-2039  ready   Omar Haddad                 943d8f26-1609-527c-a4cc-587c5876836c',
      'T-2038  ready   Chen Wei                    22e02533-09fa-571d-aef9-94f6457a88c6',
      'T-2031  ready   Bartholomew Featherstoneh…  3e5cd3e8-cd9f-54de-8a50-3736a7ea5616',
    ]);
    expect(table(100)[0]).toBe('NUMBER  STATUS  CUSTOMER NAME     DEVICE NAME       AMOUNT DUE  ID');
  });

  it('at 60 columns: the number, the status and the id', () => {
    expect(table(60)).toEqual([
      'NUMBER  STATUS  ID',
      'T-2039  ready   943d8f26-1609-527c-a4cc-587c5876836c',
      'T-2038  ready   22e02533-09fa-571d-aef9-94f6457a88c6',
      'T-2031  ready   3e5cd3e8-cd9f-54de-8a50-3736a7ea5616',
    ]);
  });

  it('keeps the first column and the id even when they do not fit', () => {
    expect(heads(table(30))).toEqual(['NUMBER', 'ID']);
  });

  it('keeps every column asked for with --columns, shortening only free text', () => {
    const lines = renderTable(ready, { ...opts, width: 50, columns: ['number', 'customer_name', 'device_name', 'due_at'] }).split('\n');
    expect(lines).toEqual([
      'NUMBER  CUSTOMER NAME   DEVICE NAME     DUE AT',
      'T-2039  Omar Haddad     Samsung Galax…  2026-11-01',
      'T-2038  Chen Wei        Apple iPad Ai…  2026-11-01',
      'T-2031  Bartholomew F…  Apple iPhone …  2026-11-01',
    ]);
  });
});

describe('all-day times', () => {
  it('shows only the date when the record says the time is all day', () => {
    const row = { due_at: '2026-11-01T01:42:00Z', due_all_day: true, created_at: '2026-11-01T01:42:00Z' };
    expect(renderRecord(row, opts)).toBe('due_at:       2026-11-01\ndue_all_day:  yes\ncreated_at:   2026-11-01 01:42');
    expect(renderRecord({ ...row, due_all_day: false }, opts).split('\n')[0]).toBe('due_at:       2026-11-01 01:42');
  });
});

describe('records', () => {
  it('shows key: value lines, nested objects indented, arrays of records as items', () => {
    const sale = { sale: { id: 's1', number: 'R1-10481', currency: 'USD', total_minor: 2176, refunded: false, note: null, at: '2026-11-01T12:00:00Z', lines: [{ name: 'Screen', price_minor: 2000 }], tags: ['a', 'b'] } };
    expect(renderHuman(sale, opts)).toBe([
      'id:        s1',
      'number:    R1-10481',
      'currency:  USD',
      'total:     21.76 USD',
      'refunded:  no',
      'note:      -',
      'at:        2026-11-01 12:00',
      'lines:',
      '  - name:   Screen',
      '    price:  20.00 USD',
      'tags:      a, b',
    ].join('\n'));
  });

  it('prints an empty record as such', () => {
    expect(renderRecord({}, opts)).toBe('(empty)');
  });

  it('keeps JSON as the API sent it', () => {
    expect(renderJson({ total_minor: 2176 })).toBe('{\n  "total_minor": 2176\n}');
  });
});

describe('values that are not text', () => {
  it('are written as JSON, never as "[object Object]"', () => {
    expect([renderHuman(42), renderHuman(true), renderHuman('ready')]).toEqual(['42', 'true', 'ready']);
    expect(formatScalar({ sku: 'a' }, 'part', undefined)).toBe('{"sku":"a"}');
    expect(formatScalar(['a', 1], 'tags', undefined)).toBe('["a",1]');
    expect(formatScalar(2.5, 'qty', undefined)).toBe('2.5');
  });
});
