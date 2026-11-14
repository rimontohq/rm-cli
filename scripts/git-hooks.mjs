// The prepare script (package.json), which npm runs after `npm install` and `npm ci`: installs git's hooks (lefthook.yml) in a
// checkout of this repository or a worktree of it, and says nothing anywhere else. The server's deploy runs npm ci in the
// commit's files, which have no .git (rm-infra: ops/server/deploy.sh), and `lefthook install` printed git's "fatal: not a git
// repository" into every deploy's log. It never fails an install: in a checkout, what lefthook says when it fails is printed,
// and the install goes on, as `lefthook install || exit 0` did. Its test runs the prepare script as npm does, with and without
// .git (git-hooks.test.mjs).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** lefthook's own command (its package's bin), run by this node: no shell and no PATH, the same on Windows. */
function lefthook() {
  try {
    return createRequire(import.meta.url).resolve('lefthook');
  } catch {
    return null;
  }
}

// .git is a folder in a checkout and a file in a worktree: either way it is this repository's own. Git's own answer (git
// rev-parse) would also find a repository around this folder, whose hooks are not this one's.
if (existsSync(join(ROOT, '.git'))) {
  const bin = lefthook();
  if (bin) spawnSync(process.execPath, [bin, 'install'], { cwd: ROOT, stdio: 'inherit' });
  else console.error("git's hooks were not installed, as lefthook is not in node_modules: npm ci installs it.");
}
