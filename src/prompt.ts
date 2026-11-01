// Reading a secret from the terminal without showing it, and reading all of stdin.

import { CliError, EXIT } from './errors.ts';

export interface TtyInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (raw: boolean) => unknown;
}

/** Asks on stderr and reads one line with echo off. Ctrl-C stops the CLI. */
export function readHidden(question: string, stdin: TtyInput, stderr: { write(s: string): unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let value = '';
    const done = (err?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new CliError('cancelled', [], EXIT.interrupted));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode?.(true);
    stdin.setEncoding?.('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

export async function readAll(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}
