// The `rimonto` executable: the real process around src/cli.ts.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { run } from './cli.ts';

const NODE_MAJOR = 22;
if (Number(process.versions.node.split('.')[0]) < NODE_MAJOR) {
  process.stderr.write(`rimonto: needs Node.js ${NODE_MAJOR} or later; this is Node.js ${process.versions.node}\n`);
  process.exit(1);
}

// `rimonto … | head` closes the pipe early: that is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

process.exitCode = await run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  platform: process.platform,
  homedir: homedir(),
  randomUUID,
  readFile: (path) => readFileSync(path, 'utf8'),
});
