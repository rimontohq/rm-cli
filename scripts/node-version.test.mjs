// The Node this repository runs on is the CI's: the same test in every Rimonto repository, on node:test
// (`node --test scripts/node-version.test.mjs`). .nvmrc, which nvm, fnm and the workspace's doctor read on a computer, names the
// Node of the CI's runner image (rm-infra: ops/ci/runner.Dockerfile), which runs this test in the check; and every Node a file
// of the repository pins (a Dockerfile's FROM node:, a pipeline's image: node: or node-version:) is that one too. Node moves to
// a new major everywhere at once, never one file alone (skill renovate, "Node"). On a computer, a failure of the first test
// means that computer runs another Node than the repository's: `nvm use`.
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

/** Each Node a tracked file pins, as [file, major]: Dockerfiles' FROM node:, and YAML's image: node: and node-version:. */
function pins() {
  // Without the variables a git hook sets, which would send git to the repository being pushed.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, env, encoding: 'utf8' }).split('\0');
  const found = [];
  for (const file of files) {
    const name = file.split('/').pop();
    const pattern = /Dockerfile/.test(name)
      ? /^FROM\s+(?:--platform=\S+\s+)?(?:docker\.io\/)?(?:library\/)?node:v?(\d+)/gm
      : /\.ya?ml$/.test(name) ? /(?:image:\s*["']?(?:docker\.io\/)?(?:library\/)?node:v?|node-version:\s*["']?v?)(\d+)/g : null;
    if (!pattern) continue;
    for (const [, major] of readFileSync(join(ROOT, file), 'utf8').matchAll(pattern)) found.push([file, major]);
  }
  return found;
}

test('every Node a file of the repository pins is the Node of .nvmrc', () => {
  assert.deepEqual(pins().filter(([, major]) => major !== NVMRC).map(([file, major]) => `${file}: Node ${major}`), []);
});
