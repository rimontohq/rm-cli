import { describe, expect, it } from 'vitest';
import { GLOBAL_FLAGS, buildInput, commandFlags, globalOptions, parseLine } from '../src/args.ts';
import { UsageError } from '../src/errors.ts';
import { generate } from '../src/generate.ts';
import type { Command } from '../src/types.ts';
import { listsSpec, specTable } from './helpers.ts';

const table = specTable();
const lists = generate(listsSpec());
const cmd = (words: string, t = table): Command => t.commands.find((c) => c.words.join(' ') === words)!;
const ID = '6f1c2a0e-6d8b-4a59-9d1f-3c1f6f3b8e21';
const STORE = '51000000-0000-4000-8000-000000000001';

const noData = async () => {
  throw new Error('no --data expected');
};

async function input(command: Command, argv: string[], readData: (s: string) => Promise<string> = noData) {
  return buildInput(command, parseLine(argv, [...GLOBAL_FLAGS, ...commandFlags(command)]), readData);
}

async function usageError(p: Promise<unknown>): Promise<UsageError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(UsageError);
  return err as UsageError;
}

describe('arguments and body', () => {
  it('takes path parameters as positionals and typed flags as body fields', async () => {
    const i = await input(cmd('tickets set-status'), [ID, '--status', 'ready', '--text', 'Your phone is ready']);
    expect(i.params).toEqual({ id: ID });
    expect(i.body).toEqual({ status: 'ready', text: 'Your phone is ready' });
  });

  it('takes a negative number after a flag as its value', async () => {
    const i = await input(cmd('stores stock adjust'), [STORE, '--product-id', ID, '--delta', '-2', '--reason', 'recount']);
    expect(i.body).toEqual({ product_id: ID, delta: -2, reason: 'recount' });
    const rate = await input(cmd('stores update'), [ID, '--tax-rate', '-.5']);
    expect(rate.body).toEqual({ tax_rate: -0.5 });
    // Not after a value flag, a dash still starts a flag.
    await usageError(input(cmd('stores update'), [ID, '--allow-tax-exempt', '-2']));
  });

  it('types integers, numbers and booleans, with --no- for false', async () => {
    const i = await input(cmd('stores update'), [ID, '--tax-rate', '0.2', '--allow-tax-exempt', '--name=Fix It']);
    expect(i.body).toEqual({ tax_rate: 0.2, allow_tax_exempt: true, name: 'Fix It' });
    const off = await input(cmd('stores update'), [ID, '--allow-tax-exempt', '--no-allow-tax-exempt']);
    expect(off.body).toEqual({ allow_tax_exempt: false });
    const money = await input(cmd('stores products update'), [STORE, ID, '--price-minor', '2500']);
    expect(money.body).toEqual({ price_minor: 2500 });
  });

  it('lets null clear a nullable number', async () => {
    expect((await input(cmd('stores update'), [ID, '--tax-rate', 'null'])).body).toEqual({ tax_rate: null });
  });

  it('refuses a value of the wrong type, with a hint for money', async () => {
    const e = await usageError(input(cmd('stores products update'), [STORE, ID, '--price-minor', '25.00']));
    expect(e.message).toBe('--price-minor must be a whole number (got "25.00")');
    expect(e.hint).toMatch(/minor units/);
  });

  it('refuses a value outside an enum, listing the allowed ones and the closest', async () => {
    const e = await usageError(input(cmd('tickets set-status'), [ID, '--status', 'redy']));
    expect(e.message).toBe('--status must be one of: new, diagnosing, awaiting_approval, waiting_parts, in_repair, ready (got "redy")');
    expect(e.hint).toBe('Did you mean ready?');
  });

  it('reports every missing required field at once, saying which go in --data', async () => {
    const e = await usageError(input(cmd('customers create'), ['--first-name', 'Ana']));
    expect(e.message).toBe('customers create: missing --store-id, "consent" (set it in --data)');
  });

  it('reads --data as JSON, @file or stdin, and lets flags override its keys', async () => {
    const reads: string[] = [];
    const read = async (s: string) => {
      reads.push(s);
      return '{"status": "new", "text": "from data"}';
    };
    const i = await input(cmd('tickets set-status'), [ID, '-d', '@body.json', '--status', 'ready'], read);
    expect(reads).toEqual(['@body.json']);
    expect(i.body).toEqual({ status: 'ready', text: 'from data' });
    const e = await usageError(input(cmd('tickets set-status'), [ID, '--data', '{nope'], async (s) => s));
    expect(e.message).toMatch(/^--data is not valid JSON/);
  });

  it('checks required fields after --data is merged', async () => {
    const i = await input(cmd('customers create'), ['--store-id', STORE, '--data', '{"consent": {"updates": true, "marketing": false}}'], async (s) => s);
    expect(i.body).toEqual({ consent: { updates: true, marketing: false }, store_id: STORE });
  });

  it('repeats array flags, and splits commas where a value cannot hold one', async () => {
    const i = await input(cmd('api-keys create'), ['--name', 'Bookings', '--store-ids', `${STORE},${ID}`]);
    expect(i.body).toEqual({ name: 'Bookings', store_ids: [STORE, ID] });
    const l = await input(cmd('tickets list', lists), ['--status', 'new', '--status', 'ready']);
    expect(l.query).toEqual([['status', 'new'], ['status', 'ready']]);
    const c = await input(cmd('tickets list', lists), ['--status', 'new,ready']);
    expect(c.query).toEqual([['status', 'new'], ['status', 'ready']]);
  });

  it('takes the list flags on a list with pages', async () => {
    const i = await input(cmd('tickets list', lists), ['--all', '--limit', '30', '--page-size', '10', '--page-token', 'abc', '--columns', 'id,status']);
    expect(i.list).toEqual({ all: true, limit: 30, pageSize: 10, pageToken: 'abc' });
    expect(i.columns).toEqual(['id', 'status']);
    await usageError(input(cmd('tickets list', lists), ['--limit', '0']));
  });

  it('wants a UUID where the path takes an id', async () => {
    const e = await usageError(input(cmd('tickets set-status'), ['T-2041', '--status', 'ready']));
    expect(e.message).toBe('tickets set-status: <id> must be an id (a UUID), got "T-2041"');
  });

  it('counts positionals', async () => {
    expect((await usageError(input(cmd('tickets set-status'), ['--status', 'ready']))).message).toBe('tickets set-status: missing <id>');
    expect((await usageError(input(cmd('tickets set-status'), [ID, ID, '--status', 'ready']))).message).toMatch(/unexpected argument/);
  });

  it('suggests the closest flag for an unknown one', () => {
    let err: unknown;
    try {
      parseLine(['--stauts', 'ready'], [...GLOBAL_FLAGS, ...commandFlags(cmd('tickets set-status'))]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toBe('unknown flag --stauts');
    expect((err as UsageError).hint).toBe('Did you mean --status?');
  });

  it('sends {} for a required body with no fields given, and nothing when there is no body', async () => {
    expect((await input(cmd('tickets cancel'), [ID])).body).toEqual({});
    expect((await input(cmd('tickets reopen'), [ID])).body).toBeUndefined();
  });

  it('reads the global flags, the last one winning', () => {
    const { occurrences } = parseLine(['--profile', 'a', '-H', 'X-A: 1', '--header', 'X-B: 2', '--profile', 'b', '--json', '--timeout', '5'], GLOBAL_FLAGS);
    expect(globalOptions(occurrences)).toMatchObject({ profile: 'b', headers: ['X-A: 1', 'X-B: 2'], json: true, timeout: 5 });
    expect(() => globalOptions(parseLine(['--timeout', 'soon'], GLOBAL_FLAGS).occurrences)).toThrow(UsageError);
  });
});
