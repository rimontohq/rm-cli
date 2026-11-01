import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { CliError } from '../src/errors.ts';
import { readHidden, type TtyInput } from '../src/prompt.ts';

/** A terminal's stdin in raw mode: the test types into it. */
function terminal() {
  const raw: boolean[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (on: boolean) => raw.push(on),
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  }) as unknown as TtyInput;
  let shown = '';
  const stderr = { write: (s: string) => (shown += s) };
  return { stdin, stderr, raw, shown: () => shown, type: (s: string) => (stdin as unknown as EventEmitter).emit('data', s) };
}

describe('readHidden', () => {
  it('reads a line without echoing it, with backspace, and leaves raw mode', async () => {
    const t = terminal();
    const answer = readHidden('API key: ', t.stdin, t.stderr);
    t.type('rimonto_sk_ab');
    t.type('\u007fc\r');
    await expect(answer).resolves.toBe('rimonto_sk_ac');
    expect(t.shown()).toBe('API key: \n');
    expect(t.raw).toEqual([true, false]);
  });

  it('takes a pasted key with its newline in one chunk', async () => {
    const t = terminal();
    const answer = readHidden('API key: ', t.stdin, t.stderr);
    t.type('rimonto_sk_pasted\n');
    await expect(answer).resolves.toBe('rimonto_sk_pasted');
  });

  it('stops on Ctrl-C', async () => {
    const t = terminal();
    const answer = readHidden('API key: ', t.stdin, t.stderr);
    t.type('abc\u0003');
    await expect(answer).rejects.toBeInstanceOf(CliError);
    expect(t.raw).toEqual([true, false]);
  });
});
