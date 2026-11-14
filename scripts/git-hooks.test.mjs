// The prepare script (package.json, ./git-hooks.mjs) and the hooks it installs from lefthook.yml: the same test in every Rimonto
// repository, on node:test (`node --test scripts/git-hooks.test.mjs`). Each case is a temporary repository holding what they
// read (package.json, lefthook.yml, scripts/git-hooks.mjs) and, where npm ci would have put it, lefthook in node_modules,
// copied from this repository's, so that a hook names the copy of the folder that installed it. The prepare script runs as npm
// runs it: by the shell, in the package's folder, with that folder's node_modules/.bin first on the PATH. Needs lefthook in
// node_modules (npm ci), as the CI's check has it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

const gitIn = (vars, dir, ...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, env: vars, encoding: 'utf8' });
const git = (dir, ...args) => gitIn(env, dir, ...args);
function gitOk(dir, ...args) {
  const run = git(dir, ...args);
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}
/** The file git runs as this hook: in a worktree, the one in its checkout's git folder. */
const hookOf = (dir, name) => gitOk(dir, 'rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`);
/** A commit of one new file, as a person makes one: lefthook skips its pre-commit checks when nothing is staged. */
function commit(dir, message, vars = env) {
  writeFileSync(join(dir, `${message}.txt`), `${message}\n`);
  gitOk(dir, 'add', `${message}.txt`);
  return gitIn(vars, dir, 'commit', '-q', '-m', message);
}

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

/** A checkout with one commit of those files, installed: npm ci, and its prepare script, as in the workspace. */
function checkout(name) {
  const dir = fill(join(base, name));
  gitOk(dir, 'init', '-q', '-b', 'dev');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-q', '-m', 'first');
  assert.equal(prepare(dir).status, 0);
  return dir;
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

test("prepare in a worktree, where .git is a file, leaves the checkout's hooks as they are", { skip }, () => {
  // Git's hooks are one set for the checkout and its worktrees. Installed from a worktree, they named its node_modules, and
  // once the worktree was removed no hook found lefthook.
  const main = checkout('main');
  const before = hooksIn(main).map((name) => [name, readFileSync(hookOf(main, name), 'utf8')]);
  const tree = join(base, 'main-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  assert.deepEqual(prepare(tree), { status: 0, output: '' });
  for (const [name, text] of before) {
    assert.equal(hookOf(tree, name), hookOf(main, name), `the worktree runs the checkout's ${name}`);
    assert.equal(readFileSync(hookOf(main, name), 'utf8'), text, `${name} still names the checkout's lefthook`);
  }
});

test('prepare does not fail an install in a checkout where lefthook cannot run, and says so', () => {
  const dir = fill(join(base, 'no-lefthook'), { modules: false });
  gitOk(dir, 'init', '-q', '-b', 'dev');
  const run = prepare(dir);
  assert.equal(run.status, 0);
  assert.match(run.output, /lefthook/);
  assert.equal(existsSync(hookOf(dir, 'pre-commit')), false);
});

test('a commit in a working tree with no node_modules is refused with what to run, and goes through once it is installed', { skip }, () => {
  // A worktree before its npm ci: the checkout's hook starts the checkout's lefthook, on the worktree's lefthook.yml.
  const main = checkout('refuse');
  for (const name of hooksIn(main)) assert.ok(config(main)[name].commands?.installed, `${name} has the check "installed"`);
  const tree = join(base, 'refuse-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  // Only that check: the others need this repository's scripts and tools, and a failure of theirs would refuse the commit for
  // another reason.
  const local = Object.entries(config(tree)).flatMap(([name, hook]) => {
    const others = Object.keys(hook?.commands ?? {}).filter((command) => command !== 'installed');
    return others.length ? [`${name}:`, '  commands:', ...others.flatMap((command) => [`    ${command}:`, '      skip: true'])] : [];
  });
  writeFileSync(join(tree, 'lefthook-local.yml'), `${local.join('\n')}\n`);

  const refused = commit(tree, 'unchecked');
  assert.notEqual(refused.status, 0, 'the commit is refused');
  assert.match(refused.stdout + refused.stderr, /node_modules is missing[^\n]*npm ci/);
  assert.equal(gitOk(tree, 'log', '-1', '--format=%s'), 'first', 'nothing was committed');

  install(tree);
  const passed = commit(tree, 'checked');
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
});

test('a hook that cannot find lefthook refuses the commit, never lets it through', { skip }, () => {
  // Installed by a lefthook that is gone since, as by npm ci in a worktree that was removed later, in a folder with no
  // node_modules where the hook's own search could find another.
  const dir = fill(join(base, 'gone'), { modules: false });
  gitOk(dir, 'init', '-q', '-b', 'dev');
  assert.equal(config(dir).assert_lefthook_installed, true, 'lefthook.yml says assert_lefthook_installed');
  const gone = join(base, 'gone-lefthook', basename(LEFTHOOK.program));
  mkdirSync(dirname(gone));
  cpSync(LEFTHOOK.program, gone);
  execFileSync(gone, ['install'], { cwd: dir, env, stdio: 'ignore' });
  rmSync(dirname(gone), { recursive: true, force: true });

  // Before it gives up, the hook asks a dozen other tools for a lefthook (go, bundler, yarn, pnpm, swift, uv, composer, mise…),
  // which takes a minute on a computer that has them: here git alone is on the PATH, beside the system's shell.
  let vars = env;
  if (process.platform !== 'win32') {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const real = env[PATH].split(delimiter).map((folder) => join(folder, 'git')).find((file) => existsSync(file));
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    vars = { ...env, [PATH]: `${bin}${delimiter}/bin` };
  }
  const refused = commit(dir, 'unchecked', vars);
  assert.notEqual(refused.status, 0, `the commit is refused: ${refused.stdout}${refused.stderr}`);
  assert.equal(git(dir, 'rev-list', '--all').stdout, '', 'nothing was committed');
});
