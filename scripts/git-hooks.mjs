// The prepare script (package.json), which npm runs after `npm install` and `npm ci`: git's hooks (lefthook.yml) installed by
// the checkout's own lefthook, so that they name it, and nothing printed where there is no git. It never fails an install:
// what goes wrong is printed, and npm goes on. The same file in every Rimonto repository.
// - A checkout, where .git is a folder: `lefthook install`, with lefthook from its node_modules.
// - A worktree, where .git is a file. Git's hooks are the checkout's, one set that every worktree of it shares, and lefthook
//   writes into them the path of the lefthook that installs them: named after a worktree, they find no lefthook once it is
//   removed (RIM-53). lefthook's own npm postinstall runs `lefthook install` wherever npm started, unless CI is set, so
//   `npm ci` in a worktree did just that (RIM-66). package.json's allowScripts denies that postinstall, which npm 11.16 and
//   later honour and npm 10 ignores; so here, after it (npm runs the dependencies' install scripts first):
//   - the checkout's own lefthook installs the hooks again, from the checkout and its lefthook.yml;
//   - a hook that still names this worktree's lefthook (one only this worktree's lefthook.yml has, such as commit-msg) is
//     removed, as it would find no lefthook once the worktree goes; each is named on stderr;
//   - when the checkout has no lefthook in its node_modules, or no lefthook.yml (it is on another branch), this worktree's
//     lefthook installs them, so that commits here are checked; they then name this worktree's lefthook, and once it is
//     removed a working tree with no lefthook of its own refuses commits (lefthook.yml's assert) until `npm ci` in the
//     checkout. stderr says which, and why.
//   A line says what changed only when something did, and names what was checked.
// - A git submodule has a .git file too, but its hooks are in the superproject's git folder: nothing there (no Rimonto
//   package is a submodule). lefthook.yml's no_auto_install keeps a worktree's lefthook from writing the hooks when it runs.
// - No .git, as in the server's deploy, which runs npm ci in a commit's files (rm-infra: ops/server/deploy.sh), and the
//   backend's Dockerfile: nothing, where `lefthook install` printed git's "fatal: not a git repository" into every log.
// Git runs here with none of the variables that point it at a repository (`git rev-parse --local-env-vars`): npm started
// from a git hook carries the hook's GIT_DIR, which would send it, and lefthook, to that repository (RIM-67). Git's own
// answer for this folder (git rev-parse) would also find a repository around it, whose hooks are not this one's, so .git
// here decides what this folder is. Its test runs the prepare script as npm does, in each of these (git-hooks.test.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

/** lefthook's command line in a folder's own node_modules (never an ancestor's), or null. */
function lefthookIn(dir) {
  const bin = join(dir, 'node_modules', 'lefthook', 'bin', 'index.js');
  return existsSync(bin) ? bin : null;
}

/** `lefthook install` in a folder by that lefthook, run by this node: no shell and no PATH, the same on Windows. Prints what
 * it says when it fails, and returns whether it worked. */
function install(dir, bin, quiet) {
  const run = spawnSync(process.execPath, [bin, 'install'], { cwd: dir, env, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (run.status === 0) return true;
  process.stderr.write(run.error ? `git's hooks: lefthook did not start: ${run.error.message}\n` : `${run.stdout ?? ''}${run.stderr ?? ''}`);
  return false;
}

/** Each hook in a hooks folder, by name, as [name, text]: none when the folder is not there (a template with no hooks/, a
 * core.hooksPath that names a folder not made yet). */
function hooks(dir) {
  if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.endsWith('.sample')).map((e) => [e.name, readFileSync(join(dir, e.name), 'utf8')]);
}

/** Whether a hook's text names a lefthook inside this folder: lefthook writes the path with / on Windows, the drive's letter
 * in either case. */
const namesLefthookIn = (text, dir) => text.replaceAll('\\', '/').toLowerCase().includes(join(dir, 'node_modules').replaceAll('\\', '/').toLowerCase());

const dotGit = statSync(join(ROOT, '.git'), { throwIfNoEntry: false });
if (dotGit?.isDirectory()) {
  const bin = lefthookIn(ROOT);
  if (bin) install(ROOT, bin, false);
  else console.error("git's hooks were not installed, as lefthook is not in node_modules: npm ci installs it.");
} else if (dotGit?.isFile()) {
  // The checkout is the folder of git's common folder, when that is a checkout's .git (a submodule's is not).
  const common = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const checkout = common && basename(common) === '.git' ? dirname(common) : null;
  if (checkout) {
    const folder = git(ROOT, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
    const before = hooks(folder);
    const bin = lefthookIn(checkout);
    const config = existsSync(join(checkout, 'lefthook.yml'));
    if (bin && config) {
      if (install(checkout, bin, true)) {
        const pointedHere = before.some(([, text]) => namesLefthookIn(text, ROOT));
        // What only this worktree's lefthook.yml has, the checkout's install leaves naming this worktree.
        const left = hooks(folder).filter(([, text]) => namesLefthookIn(text, ROOT)).map(([name]) => name);
        for (const name of left) rmSync(join(folder, name), { force: true });
        if (left.length > 0) console.error(`git's hooks: removed ${left.join(', ')}, which only this worktree's lefthook.yml has: it named this worktree's lefthook, and would find none once the worktree is removed.`);
        if (pointedHere) console.log(`git's hooks named this worktree's lefthook; they name ${checkout}'s again.`);
        else if (JSON.stringify(hooks(folder)) !== JSON.stringify(before)) console.log(`git's hooks were installed again by ${checkout}'s lefthook.`);
      }
    } else {
      // The checkout cannot install them: this worktree's lefthook does, so that commits here are checked.
      const why = bin ? `${checkout} has no lefthook.yml (it is on a branch without one)` : `${checkout} has no lefthook in node_modules`;
      const own = lefthookIn(ROOT);
      if (own && install(ROOT, own, true)) {
        console.error(`git's hooks: ${why}, so this worktree's lefthook installed them and checks commits here. They name it: once this worktree is removed, a working tree with no lefthook of its own refuses commits until \`npm ci\` in ${checkout}.`);
      } else if (hooks(folder).length === 0) {
        console.error(`git's hooks: ${why}, and this worktree's lefthook did not install them: there are none, so no commit or push here is checked until \`npm ci\` in ${checkout}.`);
      } else {
        console.error(`git's hooks: ${why}, and this worktree's lefthook did not install them: they are as they were, and \`npm ci\` in ${checkout} installs its own.`);
      }
    }
  }
}
