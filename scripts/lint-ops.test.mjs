// scripts/lint-ops.mjs: which files go to which linter, and what a missing linter or a finding does to the run.
// The end-to-end cases run it in a new git repository with stand-ins for the three linters, so they need none installed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LINTERS, group, isShellShebang, kindOf, lint } from './lint-ops.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'lint-ops.mjs');
const shellcheck = LINTERS.find(({ bin }) => bin === 'shellcheck');
const noFirstLine = () => assert.fail('the first line is read only for a file with no extension');
const missing = () => ({ error: Object.assign(new Error('spawn shellcheck ENOENT'), { code: 'ENOENT' }) });
const write = (file, text, mode = 0o644) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
};

describe('isShellShebang', () => {
  for (const line of ['#!/bin/sh', '#!/bin/bash', '#!/bin/bash -e', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash -eu', '#! /bin/dash', '#!/bin/ksh']) {
    it(`takes ${line}`, () => assert.equal(isShellShebang(line), true));
  }
  for (const line of ['#!/usr/bin/env node', '#!/bin/zsh', '#!/usr/bin/env zsh', '#!/usr/bin/env bashx', '#!/bin/sh-like', '# a comment', '', 'echo hi']) {
    it(`leaves ${JSON.stringify(line)}`, () => assert.equal(isShellShebang(line), false));
  }
});

describe('kindOf', () => {
  const cases = [
    ['ops/server/deploy.sh', 'shell'],
    ['scripts/a.bash', 'shell'],
    ['Dockerfile', 'docker'],
    ['core/Dockerfile', 'docker'],
    ['ops/ci/runner.Dockerfile', 'docker'],
    ['Dockerfile.dev', 'docker'],
    ['Dockerfile.dockerignore', null],
    ['.woodpecker/check.yaml', 'woodpecker'],
    ['.woodpecker/deploy.yml', 'woodpecker'],
    ['.woodpecker.yaml', 'woodpecker'],
    ['.woodpecker/old/check.yaml', null],
    ['.woodpecker/README.md', null],
    ['ops/compose.yaml', null],
    ['src/main.ts', null],
  ];
  for (const [file, kind] of cases) it(`${file}: ${kind}`, () => assert.equal(kindOf(file, noFirstLine), kind));

  it('reads the first line of a file with no extension', () => {
    assert.equal(kindOf('ops/ci/start-docker', () => '#!/bin/sh'), 'shell');
    assert.equal(kindOf('bin/tool', () => '#!/usr/bin/env node'), null);
    assert.equal(kindOf('LICENSE', () => 'MIT License'), null);
  });
});

describe('group', () => {
  it('puts each file with its linter and leaves the rest', () => {
    const lines = { repos: '#!/usr/bin/env bash', 'bin/cli': '#!/usr/bin/env node' };
    const groups = group(['repos', 'bin/cli', 'a.sh', 'Dockerfile', '.woodpecker/check.yaml', 'README.md'], (file) => lines[file] ?? '');
    assert.deepEqual(groups, { shell: ['repos', 'a.sh'], docker: ['Dockerfile'], woodpecker: ['.woodpecker/check.yaml'] });
  });
});

describe('lint', () => {
  it('runs nothing when there are no files of its kind', () => {
    assert.equal(lint(shellcheck, [], { spawn: () => assert.fail('nothing to run') }), 'none');
  });

  it('passes the files and the severity to the linter', () => {
    let seen;
    const lines = [];
    const result = lint(shellcheck, ['a.sh'], { spawn: (bin, args) => { seen = [bin, ...args]; return { status: 0 }; }, log: (line) => lines.push(line) });
    assert.equal(result, 'ok');
    assert.deepEqual(seen, ['shellcheck', '--severity=warning', 'a.sh']);
    assert.deepEqual(lines, ['lint-ops: shellcheck, 1 file: passed.']);
  });

  it('fails on a finding', () => {
    const lines = [];
    assert.equal(lint(shellcheck, ['a.sh'], { spawn: () => ({ status: 1 }), log: (line) => lines.push(line) }), 'failed');
    assert.deepEqual(lines, ['lint-ops: shellcheck, 1 file: failed, on what it printed above.']);
  });

  it('outside CI, skips a linter that is not installed and says how to install it', () => {
    const lines = [];
    assert.equal(lint(shellcheck, ['a.sh', 'b.sh'], { ci: false, spawn: missing, log: (line) => lines.push(line) }), 'skipped');
    assert.match(lines.join('\n'), /shellcheck is not installed here, so 2 files went unchecked/);
    assert.match(lines.join('\n'), /brew install shellcheck/);
  });

  it('in CI, fails when the linter is missing', () => {
    const lines = [];
    assert.equal(lint(shellcheck, ['a.sh'], { ci: true, spawn: missing, log: (line) => lines.push(line) }), 'failed');
    assert.match(lines.join('\n'), /runner image/);
  });
});

// A new repository, and a folder of stand-ins: each linter that is there writes the arguments it got to a file and exits with
// the code in FAIL_<NAME> (0 by default). git is reached through a stand-in too, so that PATH can leave the real linters out.
describe('the script, end to end', { skip: process.platform === 'win32' && 'the stand-ins are shell scripts' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lint-ops-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

  /** A folder with git and the given linters' stand-ins, and nothing else. */
  const bin = (name, linters) => {
    const dir = join(root, name);
    write(join(dir, 'git'), `#!/bin/sh\nexec '${realGit}' "$@"\n`, 0o755);
    for (const linter of linters) {
      const key = linter.replace('-', '_').toUpperCase();
      write(join(dir, linter), `#!/bin/sh\nprintf '%s\\n' "$@" > '${join(root, `${linter}.args`)}'\nexit "\${FAIL_${key}:-0}"\n`, 0o755);
    }
    return dir;
  };
  const allLinters = bin('all', ['shellcheck', 'hadolint', 'woodpecker-cli']);
  const noLinters = bin('none', []);
  const run = (path, args = [], env = {}) => {
    for (const linter of ['shellcheck', 'hadolint', 'woodpecker-cli']) rmSync(join(root, `${linter}.args`), { force: true });
    const { CI: _ci, ...rest } = process.env;
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', env: { ...rest, PATH: path, ...env } });
  };
  const argsOf = (linter) => (existsSync(join(root, `${linter}.args`)) ? readFileSync(join(root, `${linter}.args`), 'utf8').trim().split('\n') : null);
  const repoGit = (...args) => execFileSync(realGit, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'ignore' });

  write(join(repo, 'ops/deploy.sh'), '#!/bin/sh\necho deploy\n');
  write(join(repo, 'ops/start'), '#!/usr/bin/env bash\necho start\n');
  write(join(repo, 'ops/zsh-only'), '#!/bin/zsh\necho zsh\n');
  write(join(repo, 'bin/tool'), '#!/usr/bin/env node\n');
  write(join(repo, 'Dockerfile'), 'FROM scratch\n');
  write(join(repo, '.woodpecker/check.yaml'), 'steps: []\n');
  write(join(repo, '.woodpecker/old/check.yaml'), 'steps: []\n');
  write(join(repo, 'README.md'), '# repo\n');
  repoGit('init', '-q');
  repoGit('add', '.');
  repoGit('commit', '-q', '-m', 'first');

  it('lints every tracked file of each kind, each with its linter', () => {
    const result = run(allLinters);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argsOf('shellcheck'), ['--severity=warning', 'ops/deploy.sh', 'ops/start']);
    assert.deepEqual(argsOf('hadolint'), ['--no-color', '--failure-threshold', 'warning', 'Dockerfile']);
    assert.deepEqual(argsOf('woodpecker-cli'), ['--disable-update-check', 'lint', '--strict', '.woodpecker/check.yaml']);
  });

  it('staged: only what the commit adds or changes', () => {
    write(join(repo, 'ops/deploy.sh'), '#!/bin/sh\necho deploy again\n');
    write(join(repo, 'ops/new.sh'), '#!/bin/sh\necho new\n');
    write(join(repo, 'ops/unstaged.sh'), '#!/bin/sh\necho not staged\n');
    repoGit('add', 'ops/deploy.sh', 'ops/new.sh');
    try {
      const result = run(allLinters, ['staged']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(argsOf('shellcheck'), ['--severity=warning', 'ops/deploy.sh', 'ops/new.sh']);
      assert.equal(argsOf('hadolint'), null);
      assert.equal(argsOf('woodpecker-cli'), null);
    } finally {
      repoGit('reset', '-q', '--hard');
      rmSync(join(repo, 'ops/unstaged.sh'), { force: true });
    }
  });

  it('fails when a linter finds something, and says how to make an exception', () => {
    const result = run(allLinters, [], { FAIL_HADOLINT: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /# shellcheck disable=SC2034 # why/);
    assert.ok(argsOf('woodpecker-cli'), 'the other linters still run');
  });

  it('outside CI, skips the linters that are not installed, and passes', () => {
    const result = run(noLinters);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /shellcheck is not installed here, so 2 files went unchecked/);
    assert.match(result.stderr, /hadolint is not installed here/);
    assert.match(result.stderr, /woodpecker-cli is not installed here/);
  });

  it('in CI, fails when a linter is missing', () => {
    const result = run(noLinters, [], { CI: 'woodpecker' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shellcheck is not in this image/);
  });

  it('refuses a mode it does not know', () => {
    assert.equal(run(allLinters, ['everything']).status, 2);
  });
});
