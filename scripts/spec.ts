// Copies the API's OpenAPI document into spec/openapi.json; then run `npm run generate`. Its info.description is
// left out: it is about how the API is built, and the CLI does not show it.
//   npm run spec                       from ../rm-app-backend/core/openapi.json (the backend's checkout beside this one)
//   npm run spec -- <path or https URL>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const from = process.argv[2] ?? process.env.RIMONTO_SPEC ?? `${root}../rm-app-backend/core/openapi.json`;

const text = /^https?:\/\//.test(from) ? await (await fetch(from)).text() : readFileSync(from, 'utf8');
const doc = JSON.parse(text) as { openapi?: string; info?: { version?: string }; paths?: object };
if (!doc.openapi || !doc.paths) throw new Error(`${from} is not an OpenAPI document`);
if (doc.info) delete (doc.info as { description?: string }).description;
writeFileSync(`${root}spec/openapi.json`, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`spec/openapi.json: OpenAPI ${doc.openapi}, API ${doc.info?.version ?? '?'}, ${Object.keys(doc.paths).length} paths, from ${from}`);
