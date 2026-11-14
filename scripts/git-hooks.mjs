// The prepare script (package.json), which npm runs after `npm install` and `npm ci`: installs git's hooks (lefthook.yml) in a
// checkout of this repository, and does nothing anywhere else. The same file in every Rimonto repository.
// - A checkout, where .git is a folder: `lefthook install`, with lefthook from node_modules. It never fails an install: what
//   lefthook says when it fails is printed, and the install goes on, as `lefthook install || exit 0` did.
// - A worktree, where .git is a file: nothing. Git's hooks are the checkout's, one set that every worktree of it shares, and
//   lefthook writes into them the path of the lefthook that installed them. Installed from a worktree, they named the
//   worktree's node_modules, and once the worktree was removed no hook found lefthook any more. Installed from the checkout,
//   they name the checkout's own, which runs a worktree's commit on that worktree's lefthook.yml; and lefthook.yml's
//   no_auto_install keeps a worktree's lefthook from writing them again when it runs. A git submodule has a .git file too,
//   and its hooks are in the superproject's git folder: nothing there either (no Rimonto package is a submodule).
// - No .git, as in the server's deploy, which runs npm ci in a commit's files (rm-infra: ops/server/deploy.sh), and the
//   backend's Dockerfile: nothing, where `lefthook install` printed git's "fatal: not a git repository" into every log.
// Git's own answer (git rev-parse) would also find a repository around this folder, whose hooks are not this one's. Its test
// runs the prepare script as npm does, in each of these (git-hooks.test.mjs).
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** lefthook's command line (its package's bin/index.js), run by this node: no shell and no PATH, the same on Windows. */
function lefthook() {
  try {
    return createRequire(import.meta.url).resolve('lefthook/bin/index.js');
  } catch {
    return null;
  }
}

if (statSync(join(ROOT, '.git'), { throwIfNoEntry: false })?.isDirectory()) {
  const bin = lefthook();
  if (bin) spawnSync(process.execPath, [bin, 'install'], { cwd: ROOT, stdio: 'inherit' });
  else console.error("git's hooks were not installed, as lefthook is not in node_modules: npm ci installs it.");
}
