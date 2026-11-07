#!/usr/bin/env node
// The code that builds, deploys and runs the CI, linted the same in every Rimonto repository: shell scripts with
// shellcheck, Dockerfiles with hadolint, Woodpecker's pipelines with its own linter. The CI's check runs it (through
// `npm run lint` where the repository has npm), and the git hook before a commit runs it on what the commit adds.
//
//   node scripts/lint-ops.mjs          every file git tracks here
//   node scripts/lint-ops.mjs staged   the files a commit is about to add or change (the pre-commit hook)
//
// The files: a shell script is a *.sh or *.bash, or a file with no extension whose #! line runs sh, bash, dash or ksh;
// a Dockerfile is Dockerfile, Dockerfile.* or *.Dockerfile; a pipeline is .woodpecker/*.yaml.
// A finding of severity warning or above fails: shellcheck --severity=warning, hadolint --failure-threshold=warning,
// woodpecker-cli lint --strict (without it, even a property Woodpecker no longer has is only a warning). A reasoned
// exception stays beside what it excuses: `# shellcheck disable=SC2034 # why` on its line, or as a file's first line
// for the whole file; hadolint reads no words after `# hadolint ignore=DL3008`, so its why is the comment line above.
//
// The three binaries are in the CI's runner image, at the versions it pins (rm-infra: ops/ci/runner.Dockerfile). On a
// computer that lacks one, it is skipped with a line that says how to install it; in CI (CI is set), a missing one fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINTERS = [
  {
    kind: 'shell',
    bin: 'shellcheck',
    args: (files) => ['--severity=warning', ...files],
    install: 'brew install shellcheck (macOS, Linux), scoop install shellcheck (Windows), or https://github.com/koalaman/shellcheck#installing',
  },
  {
    kind: 'docker',
    bin: 'hadolint',
    args: (files) => ['--no-color', '--failure-threshold', 'warning', ...files],
    install: 'brew install hadolint (macOS, Linux), scoop install hadolint (Windows), or https://github.com/hadolint/hadolint/releases',
  },
  {
    kind: 'woodpecker',
    bin: 'woodpecker-cli',
    args: (files) => ['--disable-update-check', 'lint', '--strict', ...files],
    install: 'brew install woodpecker-cli (macOS, Linux), or woodpecker-cli_windows_amd64.zip from https://github.com/woodpecker-ci/woodpecker/releases',
  },
];

const SHELLS = new Set(['sh', 'bash', 'dash', 'ksh']);

/** Whether a file's first line makes it a script of a shell shellcheck reads (not zsh, which it does not). */
export function isShellShebang(line) {
  if (!line.startsWith('#!')) return false;
  const words = line.slice(2).trim().split(/\s+/);
  let program = posix.basename(words[0] ?? '');
  if (program === 'env') program = words.slice(1).find((word) => !word.startsWith('-') && !word.includes('=')) ?? '';
  return SHELLS.has(program);
}

/** Which linter a file is for: 'shell', 'docker', 'woodpecker' or null. firstLine is asked only for a file with no extension. */
export function kindOf(file, firstLine) {
  const name = posix.basename(file);
  // Woodpecker reads .woodpecker/*.yaml, not its subfolders, or a single .woodpecker.yaml at the top.
  const pipelines = file === `.woodpecker/${name}` && (name.endsWith('.yaml') || name.endsWith('.yml'));
  if (pipelines || file === '.woodpecker.yaml' || file === '.woodpecker.yml') return 'woodpecker';
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile') || (name.startsWith('Dockerfile.') && !name.endsWith('.dockerignore'))) {
    return 'docker';
  }
  const extension = posix.extname(name);
  if (extension === '.sh' || extension === '.bash') return 'shell';
  if (extension === '' && isShellShebang(firstLine())) return 'shell';
  return null;
}

/** The first line of a file, from its first 256 bytes; '' for what is not a readable regular file. */
export function firstLineOf(file) {
  let fd;
  try {
    if (!statSync(file).isFile()) return '';
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(256);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, read).split('\n')[0].replace(/\r$/, '');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The files of each kind, from paths relative to the repository's top. */
export function group(files, readFirstLine = firstLineOf) {
  const groups = Object.fromEntries(LINTERS.map(({ kind }) => [kind, []]));
  for (const file of files) {
    const kind = kindOf(file, () => readFirstLine(file));
    if (kind) groups[kind].push(file);
  }
  return groups;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** Every tracked file, or the files a commit is about to add or change, that are here. */
export function listFiles(mode) {
  const out = mode === 'staged'
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
    : git('ls-files', '-z');
  return out.split('\0').filter((file) => file && exists(file));
}

function exists(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false; // Deleted in the folder and not yet in git.
  }
}

/**
 * Runs one linter on its files: 'ok', 'failed', 'skipped' (not installed, outside CI) or 'none' (no files of its kind).
 */
export function lint(linter, files, { ci = Boolean(process.env.CI), spawn = spawnSync, log = console.error } = {}) {
  if (files.length === 0) return 'none';
  const run = spawn(linter.bin, linter.args(files), { stdio: 'inherit' });
  if (run.error?.code === 'ENOENT') {
    if (ci) {
      log(`lint-ops: ${linter.bin} is not in this image. It belongs in the CI's runner image (rm-infra: ops/ci/runner.Dockerfile).`);
      return 'failed';
    }
    log(`lint-ops: ${linter.bin} is not installed here, so ${count(files)} went unchecked; the CI's check runs it. To have it here: ${linter.install}.`);
    return 'skipped';
  }
  if (run.error) throw run.error;
  if (run.status !== 0) {
    log(`lint-ops: ${linter.bin}, ${count(files)}: failed, on what it printed above.`);
    return 'failed';
  }
  // Passed, though hadolint may have printed a note below the threshold.
  log(`lint-ops: ${linter.bin}, ${count(files)}: passed.`);
  return 'ok';
}

const count = (files) => (files.length === 1 ? '1 file' : `${files.length} files`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'all';
  if (mode !== 'all' && mode !== 'staged') {
    console.error('usage: node scripts/lint-ops.mjs [staged]');
    process.exit(2);
  }
  process.chdir(git('rev-parse', '--show-toplevel').trim());
  const groups = group(listFiles(mode));
  const results = LINTERS.map((linter) => lint(linter, groups[linter.kind]));
  if (results.includes('failed')) {
    console.error([
      '',
      'Fix what the linter found above. Where its rule is wrong for that line, say so beside it, with why:',
      '  # shellcheck disable=SC2034 # why       on the line (on a file\'s first line: the whole file)',
      '  # hadolint ignore=DL3008                on the line above the instruction, and why on the comment line before it',
    ].join('\n'));
    process.exit(1);
  }
}
