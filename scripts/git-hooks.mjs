// The prepare script (package.json), which npm runs after `npm install` and `npm ci`: git's hooks (lefthook.yml) installed by
// the checkout's own lefthook, so that they name it, and nothing printed where there is no git. The same file in every
// Rimonto repository.
// - A checkout, where .git is a folder: `lefthook install`, with lefthook from node_modules. It never fails an install: what
//   lefthook says when it fails is printed, and the install goes on, as `lefthook install || exit 0` did.
// - A worktree, where .git is a file. Git's hooks are the checkout's, one set that every worktree of it shares, and lefthook
//   writes into them the path of the lefthook that installs them: named after a worktree, they find no lefthook once it is
//   removed (RIM-53). lefthook's own npm postinstall runs `lefthook install` wherever npm started, unless CI is set, so
//   `npm ci` in a worktree did just that (RIM-66). package.json's allowScripts denies that postinstall, which npm 11 honours
//   and an older npm does not; so here, after it (npm runs the dependencies' install scripts first), the checkout's own
//   lefthook installs the hooks again, from the checkout, and one line says so when that changed them. A checkout with no
//   lefthook in node_modules gets a line saying to run npm ci there.
// - A git submodule has a .git file too, but its hooks are in the superproject's git folder: nothing there (no Rimonto
//   package is a submodule). lefthook.yml's no_auto_install keeps a worktree's lefthook from writing the hooks when it runs.
// - No .git, as in the server's deploy, which runs npm ci in a commit's files (rm-infra: ops/server/deploy.sh), and the
//   backend's Dockerfile: nothing, where `lefthook install` printed git's "fatal: not a git repository" into every log.
// Git runs here with none of the variables that point it at a repository (`git rev-parse --local-env-vars`): npm started
// from a git hook carries the hook's GIT_DIR, which would send it, and lefthook, to that repository (RIM-67). Git's own
// answer for this folder (git rev-parse) would also find a repository around it, whose hooks are not this one's, so .git
// here decides what this folder is. Its test runs the prepare script as npm does, in each of these (git-hooks.test.mjs).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** This environment without the variables in git's own list of those that name a repository (it gives the list whatever
 * they hold); every GIT_ variable when git cannot be asked. */
function cleanEnv() {
  const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' });
  const local = new Set(listed.status === 0 ? listed.stdout.split(/\r?\n/).filter(Boolean) : []);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => (local.size > 0 ? !local.has(name) : !name.startsWith('GIT_'))));
}
const env = cleanEnv();

/** git's answer in a folder, or null. */
function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** lefthook's command line (its package's bin/index.js) in a folder's node_modules, or null. */
function lefthookIn(dir) {
  try {
    return createRequire(join(dir, 'package.json')).resolve('lefthook/bin/index.js');
  } catch {
    return null;
  }
}

/** `lefthook install` in a folder by that folder's lefthook, run by this node: no shell and no PATH, the same on Windows. */
function install(dir, bin, stdio) {
  return spawnSync(process.execPath, [bin, 'install'], { cwd: dir, env, stdio, encoding: 'utf8' });
}

/** Each hook in a hooks folder, by name: what is there before and after an install. */
function hooks(dir) {
  const entries = dir ? readdirSync(dir, { withFileTypes: true }) : [];
  return JSON.stringify(entries.filter((e) => e.isFile() && !e.name.endsWith('.sample')).map((e) => [e.name, readFileSync(join(dir, e.name), 'utf8')]));
}

const dotGit = statSync(join(ROOT, '.git'), { throwIfNoEntry: false });
if (dotGit?.isDirectory()) {
  const bin = lefthookIn(ROOT);
  if (bin) install(ROOT, bin, 'inherit');
  else console.error("git's hooks were not installed, as lefthook is not in node_modules: npm ci installs it.");
} else if (dotGit?.isFile()) {
  // The checkout is the folder of git's common folder, when that is a checkout's .git (a submodule's is not).
  const common = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const checkout = common && basename(common) === '.git' ? dirname(common) : null;
  const bin = checkout && statSync(join(checkout, 'lefthook.yml'), { throwIfNoEntry: false }) ? lefthookIn(checkout) : null;
  if (checkout && !bin) {
    console.log(`git's hooks are ${checkout}'s, and it has no lefthook in node_modules: npm ci there installs them. Until then they may name this worktree's lefthook, which goes with it.`);
  } else if (bin) {
    const folder = git(checkout, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
    const before = hooks(folder);
    const run = install(checkout, bin, 'pipe');
    if (run.status !== 0) process.stderr.write(`${run.stdout}${run.stderr}`);
    else if (hooks(folder) !== before) console.log(`git's hooks name ${checkout}'s lefthook again: lefthook's own install had pointed them at this worktree's.`);
  }
}
