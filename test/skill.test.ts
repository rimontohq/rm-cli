// The agent skill (skills/rimonto/SKILL.md) is what an AI agent believes about this CLI, and nothing else stops it going stale:
// every command and flag it names must exist in the command table.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABLE } from '../src/generated/commands.ts';

const skill = readFileSync(fileURLToPath(new URL('../skills/rimonto/SKILL.md', import.meta.url)), 'utf8');
const [, frontmatter = '', body = ''] = skill.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];

// The CLI's own, beside the table's: src/cli.ts.
const OWN = ['login', 'logout', 'whoami', 'api', 'help', 'auth'];
const EVERY_COMMAND_FLAGS = ['--json', '--human', '--verbose', '--help', '--version', '--profile', '--api-url', '--timeout', '--header',
  '--all', '--limit', '--page-size', '--page-token', '--columns', '--data', '--idempotency-key'];

/** Every `rimonto …` in a code fence or in backticks, a line break inside backticks joined up. */
function mentions(): string[] {
  const fenced = [...body.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n').map((l) => l.replace(/^.*\$\(/, '').trim()));
  const outside = body.replace(/```[\s\S]*?```/g, '');
  const inline = [...outside.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.replace(/\s*\n\s*/g, ' ').trim());
  return [...fenced, ...inline].filter((l) => l.startsWith('rimonto ')).map((l) => l.split('|')[0]!.trim());
}

const commandOf = (words: string[]) => TABLE.commands
  .filter((c) => c.words.every((w, i) => words[i] === w))
  .toSorted((a, b) => b.words.length - a.words.length)[0];

const isGroup = (words: string[]) => TABLE.commands.some((c) => words.every((w, i) => c.words[i] === w));

/** What is wrong with one line of the skill; null when every word of it is real. */
function problem(line: string): string | null {
  const words = line.split(/\s+/).slice(1);
  const end = words.findIndex((w) => /^[-<"$@]/.test(w));
  const named = end === -1 ? words : words.slice(0, end);
  if (named.length === 0) return null; // rimonto --help, rimonto --version
  const command = commandOf(named);
  if (!command) return OWN.includes(named[0]!) || isGroup(named) ? null : `no command "${named.join(' ')}"`;
  const known = [...command.query, ...(command.body?.fields ?? [])].map((f) => `--${f.flag ?? f.name.replaceAll('_', '-')}`);
  const allowed = new Set([...known, ...known.map((f) => f.replace(/^--/, '--no-')), ...EVERY_COMMAND_FLAGS]);
  const unknown = words.filter((w) => /^--[a-z]/.test(w) && !allowed.has(w));
  return unknown.length > 0 ? `${command.words.join(' ')} has no ${unknown.join(', ')}` : null;
}

describe('the agent skill', () => {
  it('has the name and description the skills CLI reads', () => {
    expect(frontmatter).toMatch(/^name: rimonto$/m);
    expect(frontmatter).toMatch(/^description: >/m);
  });

  it('names many commands, so the next test means something', () => {
    expect(mentions().length).toBeGreaterThan(25);
  });

  it.each(mentions())('%s exists, with its flags', (line) => {
    expect(problem(line)).toBeNull();
  });

  it('never names what customers must not read', () => {
    expect(skill.toLowerCase()).not.toContain('supabase');
  });
});
