// The Node this repository runs on is the CI's: the same test in every Rimonto repository, on node:test
// (`node --test scripts/node-version.test.mjs`). .nvmrc, which nvm, fnm and the workspace's doctor read on a computer, names the
// Node of the CI's runner image (rm-infra: ops/ci/runner.Dockerfile), which runs this test in the check; and every Node a file
// of the repository pins (a Dockerfile's FROM node:, a pipeline's image: node: or node-version:) is that one too. Node moves to
// a new major everywhere at once, never one file alone (skill renovate, "Node"). On a computer, a failure of the first test
// means that computer runs another Node than the repository's: `nvm use`. A file that pins another Node on purpose says so,
// with why, in a comment on the line above the pin (or on its own line, in YAML): `# Another Node on purpose: <why>`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const majorOf = (version) => version.trim().replace(/^v/, '').split('.')[0];
const NVMRC = majorOf(readFileSync(join(ROOT, '.nvmrc'), 'utf8'));

test(".nvmrc names the Node these tests run on: in the check, the CI's runner image's", () => {
  assert.match(NVMRC, /^\d+$/, '.nvmrc names a version of Node, such as 24');
  assert.equal(majorOf(process.versions.node), NVMRC,
    `.nvmrc says Node ${NVMRC}, and these tests run on Node ${process.versions.node}: in the check, that is the CI's, which moves with every repository's .nvmrc at once (rm-infra: ops/renovate/config.js); on a computer, \`nvm use\``);
});

/** The comment that lets a pin have another Node, with why: on the line above it, or on its own line in YAML. */
const ON_PURPOSE = /#\s*Another Node on purpose:\s*\S/i;

/** The Nodes a file pins, as majors, but those marked as another on purpose: a Dockerfile's FROM node:, and YAML's image: node:
 * and node-version:. */
function pinsIn(name, text) {
  const pattern = /Dockerfile/.test(name)
    ? /^FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?(?:library\/)?node:v?(\d+)/g
    : /\.ya?ml$/.test(name) ? /(?:image:\s*["']?(?:docker\.io\/)?(?:library\/)?node:v?|node-version:\s*["']?v?)(\d+)/g : null;
  if (!pattern) return [];
  const lines = text.split('\n');
  // The marker on the pin's own line, or a comment line of its own right above it.
  const marked = (i) => ON_PURPOSE.test(lines[i]) || (/^\s*#/.test(lines[i - 1] ?? '') && ON_PURPOSE.test(lines[i - 1]));
  return lines.flatMap((line, i) => (marked(i) ? [] : [...line.matchAll(pattern)].map(([, major]) => major)));
}

/** Each Node a tracked file pins, as [file, major]. */
function pins() {
  // Without the variables a git hook sets, which would send git to the repository being pushed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, env, encoding: 'utf8' }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    const name = file.split('/').pop();
    return /Dockerfile|\.ya?ml$/.test(name) ? pinsIn(name, readFileSync(join(ROOT, file), 'utf8')).map((major) => [file, major]) : [];
  });
}

test('a pin of another Node is found, unless a comment says it is on purpose, with why', () => {
  const dockerfile = 'FROM node:24.22.2-slim AS deps\n# Another Node on purpose: the oldest one the CLI supports\nFROM node:22-slim\nFROM node:20\n';
  assert.deepEqual(pinsIn('Dockerfile', dockerfile), ['24', '20']);
  const workflow = '      node-version: 22 # Another Node on purpose: the oldest one\n      node-version: 24\n    image: node:26-alpine\n# Another Node on purpose:\n    image: node:18\n';
  assert.deepEqual(pinsIn('release.yml', workflow), ['24', '26', '18'], 'a marker with no why lets nothing through');
  assert.deepEqual(pinsIn('README.md', 'FROM node:20\nnode-version: 20'), [], 'only Dockerfiles and YAML');
});

test('every Node a file of the repository pins is the Node of .nvmrc', () => {
  assert.deepEqual(pins().filter(([, major]) => major !== NVMRC).map(([file, major]) => `${file}: Node ${major}`), []);
});
