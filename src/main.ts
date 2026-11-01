// The `rimonto` executable: the real process around src/cli.ts.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from './cli.ts';
import { configPath } from './config.ts';
import { startUpdateCheck } from './update-check.ts';
import { VERSION } from './version.ts';

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

// Whether a newer rimonto is out: asked while the command runs, told after it (src/update-check.ts).
const statePath = join(dirname(configPath(process.env, process.platform, homedir())), 'update-check.json');
const updateNotice = startUpdateCheck(VERSION, {
  env: process.env,
  stderrIsTTY: Boolean(process.stderr.isTTY),
  now: Date.now,
  fetch: globalThis.fetch,
  read: () => {
    try {
      return readFileSync(statePath, 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (text) => {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, text);
  },
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
process.stderr.write(await updateNotice());
