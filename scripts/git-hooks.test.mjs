// The prepare script (package.json, ./git-hooks.mjs) and the hooks it installs from lefthook.yml: the same test in every Rimonto
// repository, on node:test (`node --test scripts/git-hooks.test.mjs`). Each case is a temporary repository holding what they
// read (package.json, lefthook.yml, scripts/git-hooks.mjs) and, where npm ci would have put it, lefthook in node_modules,
// copied from this repository's, so that a hook names the copy of the folder that installed it. The prepare script runs as npm
// runs it: by the shell, in the package's folder, with that folder's node_modules/.bin first on the PATH. Needs lefthook in
// node_modules (npm ci), as the CI's check has it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PREPARE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.prepare;
/** What the prepare script and the hooks may read, of those this repository has. */
const FILES = ['package.json', 'lefthook.yml', 'scripts/git-hooks.mjs'].filter((file) => existsSync(join(ROOT, file)));

/** This repository's lefthook: its package, the package of its program for this system, and that program; null before npm ci. */
const LEFTHOOK = (() => {
  try {
    const pkg = dirname(createRequire(join(ROOT, 'package.json')).resolve('lefthook/package.json'));
    // As its bin/index.js finds it: node_modules/lefthook-<os>-<arch>/bin/lefthook.
    const program = createRequire(join(pkg, 'package.json'))('./get-exe.js').getExePath();
    return { pkg, platform: dirname(dirname(program)), program };
  } catch {
    return null;
  }
})();
const skip = !LEFTHOOK && 'lefthook is not in node_modules: npm ci';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'rimonto-git-hooks-')));
after(() => rmSync(base, { recursive: true, force: true }));

// Git and lefthook with no person's settings (a global core.hooksPath would send the hooks elsewhere), none of the variables a
// git hook sets (run from one, this test's git would act on the repository being pushed), and nothing that turns lefthook off
// or names another one.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|LEFTHOOK)/i.test(name)));
Object.assign(env, { HOME: base, XDG_CONFIG_HOME: base, GIT_CONFIG_NOSYSTEM: '1' });
// And no node_modules/.bin from the PATH these tests run with (npm's or npx's): each case finds lefthook only where npm would.
const PATH = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
env[PATH] = (env[PATH] ?? '').split(delimiter).filter((dir) => !/node_modules[\\/]\.bin$/.test(dir)).join(delimiter);

const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, env, encoding: 'utf8' });
function gitOk(dir, ...args) {
  const run = git(dir, ...args);
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}
/** The file git runs as this hook: in a worktree, the one in its checkout's git folder. */
const hookOf = (dir, name) => gitOk(dir, 'rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`);
/** lefthook's own reading of lefthook.yml (and a lefthook-local.yml), in a repository. */
const config = (dir) => JSON.parse(execFileSync(LEFTHOOK.program, ['dump', '--format', 'json'], { cwd: dir, env, encoding: 'utf8' }));
/** The git hooks lefthook.yml names, such as pre-commit and pre-push. */
const hooksIn = (dir) => Object.entries(config(dir)).filter(([, hook]) => hook?.commands || hook?.jobs).map(([name]) => name);

/** lefthook in the folder's node_modules as npm ci leaves it: its package, its program's, and node_modules/.bin/lefthook. */
function install(dir) {
  const modules = join(dir, 'node_modules');
  cpSync(LEFTHOOK.pkg, join(modules, 'lefthook'), { recursive: true });
  cpSync(LEFTHOOK.platform, join(modules, basename(LEFTHOOK.platform)), { recursive: true });
  mkdirSync(join(modules, '.bin'));
  if (process.platform === 'win32') writeFileSync(join(modules, '.bin', 'lefthook.cmd'), '@node "%~dp0\\..\\lefthook\\bin\\index.js" %*\r\n');
  else symlinkSync('../lefthook/bin/index.js', join(modules, '.bin', 'lefthook'));
}

/** A folder with what the prepare script and the hooks read, and lefthook in node_modules unless told not to. */
function fill(dir, { modules = true } = {}) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (const file of FILES) cpSync(join(ROOT, file), join(dir, file));
  if (modules) install(dir);
  return dir;
}

/** The prepare script as npm runs it: by the shell (sh, or cmd on Windows), with the folder's node_modules/.bin first on the PATH. */
function prepare(dir) {
  const run = spawnSync(PREPARE, { cwd: dir, shell: true, encoding: 'utf8', env: { ...env, [PATH]: join(dir, 'node_modules', '.bin') + delimiter + env[PATH] } });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("prepare says nothing in a folder without .git, as the server's deploy has it, and does not fail", { skip }, () => {
  const dir = fill(join(base, 'deploy'));
  assert.deepEqual(prepare(dir), { status: 0, output: '' });
  assert.equal(existsSync(join(dir, '.git')), false);
});

test("prepare installs git's hooks in a checkout, naming the checkout's own lefthook", { skip }, () => {
  const dir = fill(join(base, 'checkout'));
  gitOk(dir, 'init', '-q', '-b', 'dev');
  assert.equal(prepare(dir).status, 0);
  const hooks = hooksIn(dir);
  assert.ok(hooks.length > 0, 'lefthook.yml names hooks');
  for (const name of hooks) assert.ok(readFileSync(hookOf(dir, name), 'utf8').includes(join(dir, 'node_modules')), `${name} names ${dir}'s lefthook`);
});

test('prepare does not fail an install in a checkout where lefthook cannot run, and says so', () => {
  const dir = fill(join(base, 'no-lefthook'), { modules: false });
  gitOk(dir, 'init', '-q', '-b', 'dev');
  const run = prepare(dir);
  assert.equal(run.status, 0);
  assert.match(run.output, /lefthook/);
  assert.equal(existsSync(hookOf(dir, 'pre-commit')), false);
});
