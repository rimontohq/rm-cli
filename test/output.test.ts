import { describe, expect, it } from 'vitest';
import { formatMoney, formatTime, pickColumns, renderHuman, renderJson, renderRecord, renderTable } from '../src/output.ts';

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

  it('picks the id, number, names, status, money and a time, and hides foreign ids', () => {
    expect(pickColumns(Object.keys(tickets[0]!), tickets)).toEqual(['id', 'number', 'problem', 'status', 'total_minor', 'deposit_minor', 'created_at', 'tech_note']);
  });

  it('aligns columns, formats money with each row\'s currency, and right-aligns numbers', () => {
    expect(renderTable(tickets, opts)).toBe([
      'ID  NUMBER  PROBLEM  STATUS       TOTAL    DEPOSIT  CREATED AT        TECH NOTE',
      'a1  T-2041  Screen   ready   129.00 USD   0.00 USD  2026-11-01 09:00  line one line two',
      'b2  T-2042  Battery  new      89.00 EUR  10.00 EUR  2026-11-01 10:30  -',
    ].join('\n'));
  });

  it('shows the columns asked for, nested ones with dots', () => {
    const rows = [{ id: 'a', customer: { name: 'Ana' }, tags: ['vip', 'b2b'] }];
    expect(renderTable(rows, { ...opts, columns: ['customer.name', 'tags'] })).toBe('CUSTOMER NAME  TAGS\nAna            vip, b2b');
  });

  it('drops columns from the right to fit the terminal', () => {
    const out = renderTable(tickets, { ...opts, width: 30 });
    expect(out.split('\n')[0]).toBe('ID  NUMBER  PROBLEM  STATUS');
  });

  it('says so when a list is empty', () => {
    expect(renderTable([], opts)).toBe('(none)');
  });

  it('renders a list answer as its table', () => {
    expect(renderHuman({ tickets: [{ id: 'x', status: 'new' }], next_page_token: 't' }, opts)).toBe('ID  STATUS\nx   new');
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
