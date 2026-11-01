// spec/openapi.json → src/generated/commands.ts, the CLI's command table.
//   npm run generate             write it
//   npm run generate -- --check  fail when the file is not what the spec makes (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate, renderModule } from '../src/generate.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const specPath = `${root}spec/openapi.json`;
const outPath = `${root}src/generated/commands.ts`;

const table = generate(JSON.parse(readFileSync(specPath, 'utf8')));
const text = renderModule(table);

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(outPath, 'utf8');
  } catch {
    // missing: reported below
  }
  if (current !== text) {
    console.error('src/generated/commands.ts is not up to date with spec/openapi.json: run `npm run generate` and commit it.');
    process.exit(1);
  }
  console.log(`src/generated/commands.ts is up to date (${table.commands.length} commands).`);
} else {
  writeFileSync(outPath, text);
  console.log(`src/generated/commands.ts: ${table.commands.length} commands from ${table.areas.length} areas (API ${table.apiVersion}).`);
}
