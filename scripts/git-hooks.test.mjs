// The prepare script (package.json, ./git-hooks.mjs) and the hooks it installs from lefthook.yml: the same test in every Rimonto
// repository, on node:test (`node --test scripts/git-hooks.test.mjs`). Each case is a temporary repository holding what they
// read (package.json, lefthook.yml, scripts/git-hooks.mjs) and, where npm ci would have put it, lefthook in node_modules,
// linked from one copy of this repository's, so that a hook names the folder that installed it. The prepare script runs as npm
// runs it: by the shell, in the package's folder, with that folder's node_modules/.bin first on the PATH. Needs lefthook in
// node_modules (npm ci): skipped without it on a computer, failed without it in the CI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

test('lefthook is in node_modules in the CI, so no case below is skipped there', { skip: !process.env.CI && 'not in the CI' }, () => {
  assert.ok(LEFTHOOK, 'npm ci installs lefthook, a development dependency');
});

// Its real name: on Windows TEMP may hold the 8.3 short one (C:\Users\WINDMI~1), which git does not give back.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'rimonto-git-hooks-')));
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
/** Whether a hook names this folder's lefthook: lefthook writes the path with / on Windows, its drive's letter in either case. */
const names = (text, dir) => text.replaceAll('\\', '/').toLowerCase().includes(join(dir, 'node_modules').replaceAll('\\', '/').toLowerCase());
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
/** A lefthook-local.yml that leaves only the check of node_modules: the others need this repository's scripts and tools, and a
 * failure of theirs would refuse a commit for another reason. */
function onlyInstalled(dir) {
  const lines = Object.entries(config(dir)).flatMap(([name, hook]) => {
    const others = Object.keys(hook?.commands ?? {}).filter((command) => command !== 'installed');
    return others.length ? [`${name}:`, '  commands:', ...others.flatMap((command) => [`    ${command}:`, '      skip: true'])] : [];
  });
  writeFileSync(join(dir, 'lefthook-local.yml'), `${lines.join('\n')}\n`);
}

/** A folder's files as hard links to another's, or copies where a link cannot be made. */
function linkTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) linkTree(join(from, entry.name), join(to, entry.name));
    else {
      try {
        linkSync(join(from, entry.name), join(to, entry.name));
      } catch {
        cpSync(join(from, entry.name), join(to, entry.name));
      }
    }
  }
}
/** One package of lefthook, copied once into the test's folder (its program is 12 MB), for each case to link. */
function stored(pkg) {
  const copy = join(base, 'store', basename(pkg));
  if (!existsSync(copy)) cpSync(pkg, copy, { recursive: true });
  return copy;
}
/** lefthook in the folder's node_modules as npm ci leaves it: its package, its program's, and node_modules/.bin/lefthook. */
function install(dir) {
  const modules = join(dir, 'node_modules');
  for (const pkg of [LEFTHOOK.pkg, LEFTHOOK.platform]) linkTree(stored(pkg), join(modules, basename(pkg)));
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
function prepare(dir, extra = {}) {
  const run = spawnSync(PREPARE, { cwd: dir, shell: true, encoding: 'utf8', env: { ...env, ...extra, [PATH]: join(dir, 'node_modules', '.bin') + delimiter + env[PATH] } });
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

/** lefthook's own npm postinstall, as npm runs it for the folder: in lefthook's package, with INIT_CWD where npm started, and
 * not as in a CI, where it installs nothing. */
function postinstall(dir) {
  const { CI: _ci, ...vars } = env;
  return spawnSync(process.execPath, ['postinstall.js'], { cwd: join(dir, 'node_modules', 'lefthook'), env: { ...vars, INIT_CWD: dir }, encoding: 'utf8' });
}

/** A repository as a test may change it by mistake: its commits, config, index and hooks. */
function state(dir) {
  const folder = join(dir, '.git');
  return JSON.stringify([gitIn(env, dir, 'rev-list', '--all').stdout, readFileSync(join(folder, 'config'), 'utf8'), existsSync(join(folder, 'index')) && readFileSync(join(folder, 'index'), 'base64'),
    readdirSync(join(folder, 'hooks')).filter((name) => !name.endsWith('.sample'))]);
}
/** A repository of its own with one commit, for a test to show that nothing reached it. */
function sentinel(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  gitOk(dir, 'init', '-q', '-b', 'dev');
  gitOk(dir, 'commit', '-q', '--allow-empty', '-m', 'sentinel');
  return dir;
}

test('package.json denies lefthook\'s own postinstall (allowScripts), which npm 11 honours', () => {
  // It installs the hooks wherever npm starts, a worktree too (RIM-66); the prepare script installs them, from the checkout.
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).allowScripts?.lefthook, false);
});

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
  for (const name of hooks) assert.ok(names(readFileSync(hookOf(dir, name), 'utf8'), dir), `${name} names ${dir}'s lefthook`);
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

test("a commit in a worktree on another lefthook.yml leaves the checkout's hooks as they are, whichever lefthook runs it", { skip }, () => {
  // lefthook writes git's hooks again when it runs on a lefthook.yml other than the one they came from, with the path of the
  // lefthook that runs, unless lefthook.yml says no_auto_install. A worktree's branch often has another lefthook.yml; here one
  // more hook. First the checkout's lefthook runs the commit, as the hook names it; then, with the checkout's node_modules
  // gone, the hook's own search finds the worktree's (git rev-parse --show-toplevel), which would name the worktree.
  const main = checkout('resync');
  const before = hooksIn(main).map((name) => [name, readFileSync(hookOf(main, name), 'utf8')]);
  const tree = join(base, 'resync-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  appendFileSync(join(tree, 'lefthook.yml'), '\ncommit-msg:\n  commands:\n    any:\n      run: "true"\n');
  onlyInstalled(tree);
  // lefthook takes its hooks for written from this lefthook.yml when the file's time, to the second, is the one it noted at
  // the install; a worktree's is written at another time, and a test this fast could fall in the same second.
  const later = new Date(Date.now() + 60_000);
  for (const file of ['lefthook.yml', 'lefthook-local.yml']) utimesSync(join(tree, file), later, later);
  for (const [step, message] of [['the checkout', 'by-the-checkout'], ['the worktree', 'by-the-worktree']]) {
    if (step === 'the worktree') rmSync(join(main, 'node_modules'), { recursive: true, force: true });
    const run = commit(tree, message);
    assert.equal(run.status, 0, `${step}'s lefthook: ${run.stdout}${run.stderr}`);
    for (const [name, text] of before) {
      const now = readFileSync(hookOf(main, name), 'utf8');
      assert.ok(!names(now, tree), `${step}'s lefthook: ${name} does not name the worktree's lefthook`);
      assert.equal(now, text, `${step}'s lefthook: ${name} is the one the checkout installed`);
    }
    assert.equal(existsSync(hookOf(main, 'commit-msg')), false, `${step}'s lefthook: the worktree's lefthook.yml installs no hook`);
  }
});

test("npm ci in a worktree, where lefthook's own postinstall runs before prepare, leaves the hooks naming the checkout's lefthook", { skip }, () => {
  // npm runs the dependencies' install scripts, then the package's prepare. An npm that does not read allowScripts runs
  // lefthook's postinstall, which installs the hooks from the worktree (RIM-66).
  const main = checkout('postinstall');
  const before = hooksIn(main).map((name) => [name, readFileSync(hookOf(main, name), 'utf8')]);
  const tree = join(base, 'postinstall-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  assert.equal(postinstall(tree).status, 0);
  assert.ok(before.some(([name]) => names(readFileSync(hookOf(main, name), 'utf8'), tree)), "lefthook's postinstall named the worktree's lefthook, as it does");
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /git's hooks named this worktree's lefthook; they name .*'s again/);
  for (const [name, text] of before) assert.equal(readFileSync(hookOf(main, name), 'utf8'), text, `${name} names the checkout's lefthook again`);
});

/** A checkout with one commit and lefthook.yml, never installed: no npm ci, no prepare. */
function uninstalledCheckout(name, { init = [] } = {}) {
  const main = fill(join(base, name), { modules: false });
  gitOk(main, ...init, 'init', '-q', '-b', 'dev');
  writeFileSync(join(main, '.gitignore'), 'node_modules/\n');
  gitOk(main, 'add', '-A');
  gitOk(main, 'commit', '-q', '-m', 'first');
  return main;
}
/** A worktree of that checkout, installed: lefthook in its node_modules, as npm ci leaves it. */
function installedTree(main, name) {
  const tree = join(base, name);
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  return tree;
}

test('a worktree whose checkout has no lefthook in node_modules: its own lefthook installs the hooks, so commits here are checked', { skip }, () => {
  // With lefthook's postinstall denied (npm 11.16 and later), nothing else would install them: commits went unchecked.
  const main = uninstalledCheckout('uninstalled');
  const tree = installedTree(main, 'uninstalled-tree');
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /has no lefthook in node_modules, so this worktree's lefthook installed them and checks commits here/);
  for (const name of hooksIn(tree)) assert.ok(names(readFileSync(hookOf(tree, name), 'utf8'), tree), `${name} is there, naming this worktree's lefthook`);
  onlyInstalled(tree);
  const refused = commit(tree, 'checked');
  assert.equal(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /installed/, 'lefthook ran its checks');
});

test('a worktree whose checkout is on a branch with no lefthook.yml: its own lefthook installs them, and says why', { skip }, () => {
  const main = checkout('no-config');
  const tree = join(base, 'no-config-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  rmSync(join(main, 'lefthook.yml'));
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /has no lefthook\.yml \(it is on a branch without one\), so this worktree's lefthook installed them/);
  assert.equal(existsSync(join(main, 'lefthook.yml')), false, 'the checkout got no blank lefthook.yml');
});

test("a hook that only the worktree's lefthook.yml has is removed, as it names the worktree's lefthook", { skip }, () => {
  // The checkout's lefthook installs what its own lefthook.yml has; what lefthook's postinstall installed from the worktree's
  // (here commit-msg) went on naming the worktree, and would find no lefthook once it is removed.
  const main = checkout('extra-hook');
  const tree = join(base, 'extra-hook-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  appendFileSync(join(tree, 'lefthook.yml'), '\ncommit-msg:\n  commands:\n    any:\n      run: "true"\n');
  assert.equal(postinstall(tree).status, 0);
  assert.ok(names(readFileSync(hookOf(main, 'commit-msg'), 'utf8'), tree), "lefthook's postinstall installed commit-msg from the worktree");
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.equal(existsSync(hookOf(main, 'commit-msg')), false, 'commit-msg is gone');
  assert.match(run.output, /removed commit-msg, which only this worktree's lefthook\.yml has/);
  for (const name of hooksIn(main)) assert.ok(names(readFileSync(hookOf(main, name), 'utf8'), main), `${name} names the checkout's lefthook`);
});

test('a checkout with no hooks folder yet (a git template with no hooks/): a worktree\'s prepare installs them and does not fail', { skip }, () => {
  const template = join(base, 'template-without-hooks');
  mkdirSync(template);
  const main = uninstalledCheckout('templated', { init: ['-c', `init.templateDir=${template}`] });
  install(main);
  assert.equal(existsSync(hookOf(main, 'pre-commit')), false);
  assert.equal(existsSync(join(main, '.git', 'hooks')), false, 'git made no hooks folder');
  const tree = installedTree(main, 'templated-tree');
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /git's hooks were installed again by .*'s lefthook/, 'says what changed, and no more');
  assert.doesNotMatch(run.output, /named this worktree's/);
  for (const name of hooksIn(main)) assert.ok(names(readFileSync(hookOf(main, name), 'utf8'), main), `${name} names the checkout's lefthook`);
});

test('a checkout whose core.hooksPath names a folder not made yet: a worktree\'s prepare says what lefthook said, and does not fail', { skip }, () => {
  const main = checkout('hooks-path');
  gitOk(main, 'config', 'core.hooksPath', join(base, 'hooks-path-not-made'));
  const tree = installedTree(main, 'hooks-path-tree');
  const run = prepare(tree);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /hooksPath/i, "lefthook's own refusal is printed");
});

test("prepare in a checkout uses only that checkout's own lefthook, never one in a folder around it", { skip }, () => {
  const around = join(base, 'around');
  mkdirSync(around);
  install(around);
  const dir = fill(join(around, 'checkout'), { modules: false });
  gitOk(dir, 'init', '-q', '-b', 'dev');
  const run = prepare(dir);
  assert.equal(run.status, 0);
  assert.match(run.output, /lefthook is not in node_modules/);
  assert.equal(existsSync(hookOf(dir, 'pre-commit')), false, "the folder around it installed nothing");
});

test('prepare run from a git hook, with GIT_DIR naming another repository, works on its own and leaves that one alone', { skip }, (t) => {
  // npm started inside a git hook carries the hook's GIT_DIR (RIM-67).
  const main = checkout('from-a-hook');
  const before = hooksIn(main).map((name) => [name, readFileSync(hookOf(main, name), 'utf8')]);
  const tree = join(base, 'from-a-hook-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  install(tree);
  postinstall(tree);
  const other = sentinel('from-a-hook-other');
  const was = state(other);
  t.after(() => assert.equal(state(other), was, 'the other repository is as it was'));
  assert.equal(prepare(tree, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other }).status, 0);
  for (const [name, text] of before) assert.equal(readFileSync(hookOf(main, name), 'utf8'), text, `${name} names the checkout's lefthook`);
  assert.equal(state(other), was);
});

test('prepare does not fail an install in a checkout where lefthook cannot run, and says so', () => {
  const dir = fill(join(base, 'no-lefthook'), { modules: false });
  gitOk(dir, 'init', '-q', '-b', 'dev');
  const run = prepare(dir);
  assert.equal(run.status, 0);
  assert.match(run.output, /lefthook/);
  assert.equal(existsSync(hookOf(dir, 'pre-commit')), false);
});

test("no hook's command holds a double quote: on Windows lefthook gives sh the command on one command line, where a double quote ends it", { skip }, () => {
  // sh then runs only what came before that quote: `{ echo "…"; exit 1; }` became a syntax error, and every commit stopped.
  for (const [name, hook] of Object.entries(config(ROOT))) {
    const commands = [...Object.entries(hook?.commands ?? {}), ...(hook?.jobs ?? []).map((job, i) => [job.name ?? `job ${i + 1}`, job])];
    for (const [command, { run }] of commands) assert.ok(!run?.includes('"'), `${name}'s ${command}: ${run}`);
  }
});

test('a commit in a working tree with no node_modules is refused with what to run, and goes through once it is installed', { skip }, () => {
  // A worktree before its npm ci: the checkout's hook starts the checkout's lefthook, on the worktree's lefthook.yml.
  const main = checkout('refuse');
  for (const name of hooksIn(main)) assert.ok(config(main)[name].commands?.installed, `${name} has the check "installed"`);
  const tree = join(base, 'refuse-tree');
  gitOk(main, 'worktree', 'add', '-q', tree);
  onlyInstalled(tree);

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
  linkTree(join(stored(LEFTHOOK.platform), 'bin'), dirname(gone));
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


test('run as a pre-push from a worktree runs it, with GIT_DIR naming another repository, these tests leave that one alone', { skip: skip || (process.env.RIMONTO_GIT_HOOKS_INNER && 'this run is the one below') }, () => {
  // git runs a hook in a worktree with GIT_DIR and GIT_WORK_TREE set, and a test runner passes them on: every git above
  // runs in a repository of its own, and must not follow them into the real one (RIM-67: in rm-infra a push committed
  // fixture commits and set core.bare=true there).
  const other = sentinel('pushed');
  const was = state(other);
  // Without NODE_TEST_CONTEXT, which this runner sets, so the run below reports as a run of its own, in text.
  const { NODE_TEST_CONTEXT: _context, ...outer } = process.env;
  const run = spawnSync(process.execPath, ['--test', '--test-isolation=none', fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...outer, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, RIMONTO_GIT_HOOKS_INNER: '1' },
  });
  assert.equal(run.status, 0, `the tests pass that way too:\n${run.stdout.slice(-3000)}${run.stderr.slice(-2000)}`);
  assert.equal(state(other), was, 'nothing reached the repository GIT_DIR names');
});
