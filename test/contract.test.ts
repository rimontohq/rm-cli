// Every command against the API's contract (spec/openapi.json), with no server. For each command of the table: a
// command line made from the schemas (its required input, then every flag), run through the real CLI; the request it
// sends is checked against its operation (method, path, query, headers, body by JSON Schema); the answer, made from
// the operation's success schema, must print as JSON and for people. A missing required input must stop the CLI
// before it sends anything. New operations are covered as soon as `npm run generate` adds them.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLE } from '../src/generated/commands.ts';
import type { Command } from '../src/types.ts';
import {
  FULL_ANSWER, MINIMAL_ANSWER, Unsynthesisable, argvOf, fromPattern, invalid, invocation, operationOf, requestProblems, sample,
  schemaAt, type Invocation, type Operation, type SampleOptions,
} from './contract-kit.ts';
import { cli, json, type RunResult } from './helpers.ts';

const KEY = 'rimonto_sk_test_contract0000';
const API = 'https://api.example.test/core';
const BASE_PATH = '/core';
const home = mkdtempSync(join(tmpdir(), 'rimonto-contract-'));
const env = { RIMONTO_API_KEY: KEY, RIMONTO_API_URL: API };

/**
 * Operations whose schemas are too loose to make a valid request or answer from, each with its reason. Keep it small:
 * the fix is a tighter schema in the API. A test fails when an entry is no longer needed.
 */
const LOOSE: Record<string, string> = {};

interface Answer {
  status: number;
  body?: unknown;
}

/** An answer of the operation's success schema, checked against it (so a wrong answer is the synthesiser's fault). */
function answerOf(op: Operation, o: SampleOptions): Answer {
  if (!op.success.at) return { status: op.success.status };
  const body = sample(schemaAt(op.success.at), o);
  const why = invalid(op.success.at, body, 'answer');
  if (why) throw new Unsynthesisable(`the answer made from the schema is invalid: ${why}`);
  return { status: op.success.status, body };
}

function reply(a: Answer): Response {
  return a.body === undefined ? new Response(null, { status: a.status }) : json(a.status, a.body);
}

/** Output a person should never see. */
const JUNK = /\[object Object\]|\bundefined\b|\bNaN\b|Invalid Date/;

/** The request's problems: exactly one, as its operation takes it. */
function sentProblems(op: Operation, inv: Invocation, r: RunResult): string[] {
  if (r.requests.length !== 1) return [`${r.requests.length} requests, expected 1`];
  return requestProblems(op, r.requests[0]!, { basePath: BASE_PATH, path: inv.path, key: KEY });
}

/** What is wrong with a command's people output for this answer. */
function humanProblems(cmd: Command, answer: Answer, r: RunResult): string[] {
  const problems: string[] = [];
  if (JUNK.test(r.stdout)) problems.push(`junk in the output: ${JUNK.exec(r.stdout)![0]}`);
  if (answer.body === undefined) {
    if (r.stdout !== '') problems.push(`printed "${r.stdout}" for no answer`);
    if (r.stderr !== 'Done.\n') problems.push(`said "${r.stderr}" for no answer, expected Done.`);
    return problems;
  }
  if (!r.stdout.trim()) problems.push('printed nothing');
  const rows = cmd.list && (answer.body as Record<string, unknown>)[cmd.list.key];
  if (Array.isArray(rows)) {
    // A table: a header of capitals, then a line per row; rows with an id end with it, whole.
    const lines = r.stdout.trimEnd().split('\n');
    if (lines.length !== 1 + rows.length) problems.push(`${lines.length} lines for ${rows.length} rows and a header`);
    if (!/^[A-Z][A-Z0-9 ]*$/.test(lines[0]!)) problems.push(`the header is "${lines[0]}"`);
    const id = (rows[0] as Record<string, unknown>).id;
    if (typeof id === 'string' && (!/\bID$/.test(lines[0]!) || !lines[1]?.endsWith(id))) problems.push('the id is not the last column, whole');
  }
  return problems;
}

/** Runs a command line made from the spec, with --json and with --human: everything wrong, or nothing. */
async function commandProblems(cmd: Command, op: Operation, every: boolean): Promise<string[]> {
  const inv = invocation(cmd, op, every);
  const answer = answerOf(op, every ? FULL_ANSWER : MINIMAL_ANSWER);
  const argv = argvOf(inv);
  const line = `rimonto ${argv.join(' ')}`;
  const problems: string[] = [];

  const asJson = await cli([...argv, '--json'], { env, home, handler: () => reply(answer) });
  if (asJson.code !== 0) return [`${line} --json exited ${asJson.code}: ${asJson.stderr}`];
  problems.push(...sentProblems(op, inv, asJson));
  const printed = asJson.stdout === '' ? undefined : (JSON.parse(asJson.stdout) as unknown);
  if (JSON.stringify(printed) !== JSON.stringify(answer.body)) problems.push('--json did not print the answer as it came');

  const human = await cli([...argv, '--human'], { env, home, handler: () => reply(answer) });
  if (human.code !== 0) return [...problems, `${line} --human exited ${human.code}: ${human.stderr}`];
  problems.push(...sentProblems(op, inv, human), ...humanProblems(cmd, answer, human));
  return problems.map((p) => `${p}\n    (${line})`);
}

/** The command line with only the required input, made when the tests are collected; an error when it cannot be. */
function minimalOf(cmd: Command, op: Operation): Invocation | Error {
  try {
    return invocation(cmd, op, false);
  } catch (err) {
    return err as Error;
  }
}

const cases = TABLE.commands.map((cmd) => {
  const op = operationOf(cmd);
  return { name: cmd.words.join(' '), cmd, op, minimal: minimalOf(cmd, op) };
});
const strict = cases.filter((c) => !(c.op.id in LOOSE));
const lists = strict.filter((c) => c.cmd.list?.pageToken);
const withRequired = strict.flatMap((c) => {
  const inv = c.minimal;
  if (inv instanceof Error) return [];
  // A path argument: the last one missing (any one missing leaves the last without a value). Then each required flag
  // and --data field.
  const args = inv.parts.filter((p) => p.kind === 'arg');
  const parts = [...args.slice(-1), ...inv.parts.filter((p) => p.required && p.kind !== 'arg')];
  return parts.length ? [{ ...c, inv, parts }] : [];
});

describe('the contract tests', () => {
  it('cover every command of the table, each an operation of the spec', () => {
    expect(cases).toHaveLength(TABLE.commands.length);
    expect(new Set(cases.map((c) => c.op.id)).size).toBe(TABLE.commands.length);
    expect(cases.filter((c) => c.minimal instanceof Error && !(c.op.id in LOOSE)).map((c) => `${c.name}: ${(c.minimal as Error).message}`)).toEqual([]);
  });

  it('skip only the operations listed with a reason, and only while they still cannot be made', () => {
    expect(Object.keys(LOOSE).length).toBeLessThanOrEqual(3);
    const stale = Object.entries(LOOSE).filter(([id, reason]) => {
      const c = cases.find((x) => x.op.id === id);
      if (!c || !reason) return true;
      try {
        invocation(c.cmd, c.op, true);
        answerOf(c.op, FULL_ANSWER);
        answerOf(c.op, MINIMAL_ANSWER);
        return true;
      } catch (err) {
        return !(err instanceof Unsynthesisable);
      }
    });
    expect(stale.map(([id]) => `${id}: no longer an operation, or it can be made now: take it off the list`)).toEqual([]);
  });

  it('make strings for the patterns of the spec', () => {
    expect(fromPattern('^([01]\\d|2[0-3]):[0-5]\\d$')).toBe('00:00');
    expect(fromPattern('^(\\+[1-9]\\d{6,14}|MG[0-9a-fA-F]{32})$')).toBe('+1000000');
    expect(fromPattern('^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$')).toBe('sk_test_AAAAAAAAAA');
    expect(() => fromPattern('^(?=x)')).toThrow(Unsynthesisable);
  });
});

describe.each(strict)('rimonto $name', ({ cmd, op }) => {
  it('sends what the spec accepts with only the required input, and prints the smallest answer', async () => {
    expect(await commandProblems(cmd, op, false)).toEqual([]);
  });

  it('sends what the spec accepts with every flag, and prints the fullest answer', async () => {
    expect(await commandProblems(cmd, op, true)).toEqual([]);
  });
});

describe.each(lists)('rimonto $name --all', ({ cmd, op }) => {
  it('follows the pages, sending only the parameters the list takes', async () => {
    const inv = invocation(cmd, op, false);
    const page = answerOf(op, MINIMAL_ANSWER).body as Record<string, unknown>;
    const r = await cli([...argvOf(inv), '--all', '--json'], {
      env, home,
      handler: (_, n) => json(200, n === 1 ? { ...page, next_page_token: 'page-2' } : page),
    });
    expect(r.code, `${r.stderr}`).toBe(0);
    expect(r.requests.flatMap((req) => requestProblems(op, req, { basePath: BASE_PATH, path: inv.path, key: KEY }))).toEqual([]);
    expect(r.requests.map((req) => new URL(req.url).searchParams.get(cmd.list!.pageToken!))).toEqual([null, 'page-2']);
    const rows = page[cmd.list!.key] as unknown[];
    expect(JSON.parse(r.stdout)[cmd.list!.key]).toHaveLength(rows.length * 2);
  });
});

describe.each(withRequired)('rimonto $name without its required input', ({ cmd, inv, parts }) => {
  it.each(parts)('refuses a missing $missing, before sending anything', async (part) => {
    const r = await cli(argvOf(inv, part), { env, home, handler: () => json(200, {}) });
    expect(r.code, `${r.stderr}`).toBe(64);
    expect(r.stderr).toContain(`rimonto: ${cmd.words.join(' ')}: missing `);
    expect(r.stderr).toContain(part.missing);
    expect(r.requests).toHaveLength(0);
  });
});
