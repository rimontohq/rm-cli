#!/usr/bin/env node
// Secret scanning with gitleaks (https://github.com/gitleaks/gitleaks), the same in every Rimonto repository: the git hook
// before a commit, `npm run lint` (so the check and the hook before a push), and an audit of the whole history. Rules: gitleaks'
// own and this repository's .gitleaks.toml (Rimonto's API keys, Supabase's secret keys, and what here only looks like a key).
//
//   node scripts/gitleaks.mjs staged    what a commit is about to add (the pre-commit hook)
//   node scripts/gitleaks.mjs branch    the commits not yet on dev: in a pull request's check, its target branch's
//   node scripts/gitleaks.mjs history   every commit there is
//   node scripts/gitleaks.mjs <args>    gitleaks itself, with these arguments
//
// No install step on any computer: gitleaks VERSION is downloaded once from its official release into a cache folder of
// this user (GITLEAKS_CACHE to put it elsewhere), and kept only if its SHA-256 is the one written below, on macOS, Linux and
// Windows. Secrets are never printed (--redact). Exits as gitleaks does: 1 when it found a leak.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '8.30.1';
/** From the release's gitleaks_8.30.1_checksums.txt. */
const SHA256 = {
  'darwin-arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  'darwin-x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  'linux-arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  'linux-x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  'win32-arm64': 'b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f',
  'win32-x64': 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
};

const cacheRoot = () => process.env.GITLEAKS_CACHE
  ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? tmpdir(), 'rimonto') : join(homedir(), '.cache', 'rimonto'));

/** The pinned gitleaks for this computer, downloaded and checked the first time. */
export async function gitleaks() {
  const platform = `${process.platform}-${process.arch}`;
  const sha = SHA256[platform];
  if (!sha) throw new Error(`gitleaks ${VERSION} has no build for ${platform} here.`);
  const dir = join(cacheRoot(), 'gitleaks', VERSION);
  const bin = join(dir, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
  if (existsSync(bin)) return bin;
  const [os, arch] = [{ darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform], process.arch];
  const file = `gitleaks_${VERSION}_${os}_${arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const res = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${file}`);
  if (!res.ok) throw new Error(`Downloading ${file} failed: ${res.status}.`);
  const archive = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(archive).digest('hex');
  if (got !== sha) throw new Error(`${file} is not the release's file (SHA-256 ${got}, expected ${sha}): not used.`);
  const work = `${dir}.part-${process.pid}`;
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, file), archive);
  // Windows 10 and later have bsdtar as tar.exe, which reads zip too.
  execFileSync('tar', ['-xf', file], { cwd: work, stdio: 'ignore' });
  rmSync(join(work, file));
  if (process.platform !== 'win32') chmodSync(join(work, 'gitleaks'), 0o755);
  try {
    renameSync(work, dir);
  } catch {
    rmSync(work, { recursive: true, force: true }); // Another run put it there first.
  }
  return bin;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** The commits of this branch that dev does not have yet: a pull request's against its target, here against origin/dev. */
function branchRange() {
  const target = process.env.CI_COMMIT_TARGET_BRANCH;
  const base = target ? `origin/${target}` : 'origin/dev';
  if (target) {
    try { git('fetch', '-q', '--unshallow'); } catch { /* a full clone already */ }
    try { git('fetch', '-q', '--no-tags', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`); } catch { /* offline */ }
  }
  try {
    git('rev-parse', '--verify', '-q', base);
    return `${base}..HEAD`;
  } catch {
    return null;
  }
}

/** The arguments for gitleaks of a mode, or the arguments as they are. */
export function argsFor(mode, rest, range = branchRange) {
  const common = ['--redact', '--verbose', '--no-banner', '--log-level', 'warn', '--config', '.gitleaks.toml'];
  if (mode === 'staged') return ['git', '--pre-commit', '--staged', ...common, ...rest];
  if (mode === 'history') return ['git', ...common, ...rest];
  if (mode === 'branch') {
    const commits = range();
    // On dev itself, or with no dev to compare with: the files as they are now.
    return commits ? ['git', `--log-opts=${commits}`, ...common, ...rest] : ['dir', '.', ...common, ...rest];
  }
  return [mode, ...rest].filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  let bin;
  try {
    bin = await gitleaks();
  } catch (error) {
    console.error(`rimonto: secret scanning could not start: ${error.message}`);
    process.exit(2);
  }
  const run = spawnSync(bin, argsFor(mode, rest), { stdio: 'inherit' });
  if (run.status === 1) {
    console.error([
      '',
      'gitleaks found what looks like a secret (shown REDACTED above, with its file and line).',
      'A real key: take it out of the change, keep it in Infisical (skill rimonto:secrets), and rotate it if it was ever pushed.',
      'Something that only looks like one (a test\'s fake key, a public id): add it to .gitleaks.toml with why.',
      'Never skip the hook with --no-verify.',
    ].join('\n'));
  }
  process.exit(run.status ?? 2);
}
