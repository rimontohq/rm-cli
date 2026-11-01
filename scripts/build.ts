// src/main.ts → dist/rimonto.js: one file, no dependencies, for Node 22 and later; `bin` in package.json.
import { chmodSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version: string };
const outfile = `${root}dist/rimonto.js`;

await build({
  entryPoints: [`${root}src/main.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { RIMONTO_VERSION: JSON.stringify(version) },
  minifySyntax: true,
  legalComments: 'none',
  logLevel: 'warning',
});
chmodSync(outfile, 0o755);
console.log(`dist/rimonto.js: rimonto ${version}, ${Math.round(statSync(outfile).size / 1024)} KB`);
