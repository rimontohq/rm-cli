// Fails a pull request that changes what users get without raising the version. A merge into dev publishes a raised
// version by itself (.github/workflows/release.yml), so a change that keeps the version would never reach anyone.
//   node scripts/version-check.mjs [base]    base: what the pull request goes into (default origin/dev)
// What users get: src/, spec/ (the command table is built from it) and the build script. Tests, CI, docs and dev
// dependencies need no new version; a raised version with none of these still publishes (a README for npm's page).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'origin/dev';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const SHIPPED = [/^src\//, /^spec\//, /^scripts\/build\.ts$/];

const parse = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

const changed = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
const shipped = changed.filter((f) => SHIPPED.some((re) => re.test(f)));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const before = JSON.parse(git('show', `${base}:package.json`)).version;

function fail(lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

if (version !== before && !newer(version, before)) {
  fail([`The version goes back: ${before} → ${version}. A new version is higher than the last one.`]);
}
if (shipped.length && !newer(version, before)) {
  fail([
    `This changes what users get (${shipped.slice(0, 5).join(', ')}${shipped.length > 5 ? ', …' : ''}), but the version stays ${version}.`,
    'Its merge into dev publishes a raised version by itself; raise it in this pull request:',
    '  npm version patch --no-git-tag-version   a fix',
    '  npm version minor --no-git-tag-version   a new command, flag or behaviour',
    '  npm version major --no-git-tag-version   something that breaks how people use it',
  ]);
}
if (newer(version, before)) {
  let published = false;
  try {
    published = execFileSync('npm', ['view', `rimonto@${version}`, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
  } catch {
    // not on npm: as it should be
  }
  if (published) fail([`rimonto ${version} is on npm already: raise the version past it.`]);
  console.log(`version: ${before} → ${version}; the merge into dev publishes it.`);
} else {
  console.log(`version: stays ${version}; nothing here changes what users get, so the merge publishes nothing.`);
}
