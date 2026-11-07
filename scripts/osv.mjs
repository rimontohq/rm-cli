#!/usr/bin/env node
// Known vulnerabilities in this repository's dependencies, the same in every Rimonto repository: OSV-Scanner
// (https://google.github.io/osv-scanner/) reads every lock file git does not ignore (package-lock.json, the iPad app's
// Package.resolved) and asks the OSV database (https://osv.dev) which of their versions have a known vulnerability.
// The CI's check runs it.
//
//   node scripts/osv.mjs     every lock file here; exits 1 on a finding this repository has not dealt with
//
// git names the lock files, by the names in LOCK_FILES: tracked ones and new ones it does not ignore. OSV-Scanner's own
// search (--recursive) is not used, as it applies the .gitignore of every folder above the repository too: in the
// Rimonto workspace, whose own repository ignores the rm-* folders inside it, it found nothing and passed.
//
// Every finding fails until it is dealt with, in one of two ways:
// - it has a fixed version: move to it. A direct dependency in package.json; one that comes through another with
//   `npm update <name>`, or the other one's update. Renovate opens a pull request for a direct one (osvVulnerabilityAlerts).
// - it has none yet, or our code never reaches it: write it down in osv-scanner.toml at the top of the repository, with
//   why and until when (at most MAX_DAYS ahead). On that day it fails again, to be looked at anew:
//       [[IgnoredVulns]]
//       id = "GHSA-xxxx-xxxx-xxxx"
//       ignoreUntil = 2027-01-31
//       reason = "Only the build's dev server uses it, on developers' own computers; no fix released yet."
//   An entry with no reason or no ignoreUntil, or one further ahead than that, fails too.
//
// The database is not in the binary: each scan sends the packages to osv.dev's API (api.osv.dev) and gets back what is
// known about them that day. So a new advisory reaches the check without a change here, and the scan needs the network.
// The binary is in the CI's runner image, at the version it pins (rm-infra: ops/ci/runner.Dockerfile). On a computer that
// lacks it, the scan is skipped with a line that says how to install it; in CI (CI is set), a missing one fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = 'osv-scanner';
export const CONFIG = 'osv-scanner.toml';
/** How far ahead an exception may run before it is looked at again. */
export const MAX_DAYS = 90;
const INSTALL = 'brew install osv-scanner (macOS, Linux), scoop install osv-scanner (Windows), or https://github.com/google/osv-scanner/releases';

/**
 * The names of the lock files OSV-Scanner reads (its docs: "Supported languages and lockfiles"). A repository with another
 * kind adds its name here, in rm-infra's copy first.
 */
export const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', // JavaScript
  'Package.resolved', 'Podfile.lock', // Swift
  'go.mod', 'Cargo.lock', 'Gemfile.lock', 'gems.locked', 'composer.lock', 'pubspec.lock', 'mix.lock', 'conan.lock', 'renv.lock',
  'requirements.txt', 'Pipfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock', // Python
  'gradle.lockfile', 'buildscript-gradle.lockfile', 'packages.lock.json', // Java, .NET
]);

export const args = (config, files) => [
  'scan', 'source', '--format', 'json',
  ...(config ? ['--config', config] : []),
  ...files.flatMap((file) => ['--lockfile', file]),
];

/** The lock files among paths relative to the repository's top. */
export const lockFilesOf = (paths) => paths.filter((path) => LOCK_FILES.has(path.split('/').pop()));

/** The files git tracks here, and the new ones it does not ignore. */
export function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter((file) => file && existsSync(`${root}/${file}`)))];
}

/** Compares two versions as semver does (numbers by value, a pre-release before its release); <0, 0 or >0. */
export function compareVersions(a, b) {
  const [x, y] = [splitVersion(a), splitVersion(b)];
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const order = comparePart(x.main[i] ?? '0', y.main[i] ?? '0');
    if (order !== 0) return order;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const [p, q] = [x.pre.split('.'), y.pre.split('.')];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const order = comparePart(p[i], q[i]);
    if (order !== 0) return order;
  }
  return 0;
}

/** A version's numbers and its pre-release, without a leading v or build metadata. */
function splitVersion(version) {
  const [main, ...pre] = String(version).replace(/^v/, '').split('+')[0].split('-');
  return { main: main.split('.'), pre: pre.join('-') };
}

function comparePart(a, b) {
  const [m, n] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (m && n) return Number(a) - Number(b);
  if (m !== n) return m ? -1 : 1; // Numbers before words, as semver orders pre-release parts.
  return a < b ? -1 : Number(a > b);
}

/**
 * The lowest version that fixes these vulnerabilities for this package, above the one installed; null when none is
 * released. Only the advisory's entries for this very package count, and only a version range's `fixed` events.
 */
export function fixedVersion(vulnerabilities, pkg) {
  let lowest = null;
  for (const vulnerability of vulnerabilities) {
    for (const affected of vulnerability.affected ?? []) {
      if (affected.package?.name !== pkg.name || affected.package?.ecosystem !== pkg.ecosystem) continue;
      for (const range of affected.ranges ?? []) {
        if (range.type === 'GIT') continue;
        for (const { fixed } of range.events ?? []) {
          if (fixed === undefined || compareVersions(fixed, pkg.version) <= 0) continue;
          if (lowest === null || compareVersions(fixed, lowest) < 0) lowest = fixed;
        }
      }
    }
  }
  return lowest;
}

/** Each vulnerability OSV-Scanner reported, once per package and lock file, from its JSON output. */
export function findings(report, root = process.cwd()) {
  const out = [];
  for (const result of report?.results ?? []) {
    const file = relative(real(root), real(result.source?.path ?? '')) || result.source?.path;
    for (const { package: pkg, groups = [], vulnerabilities = [], dependency_groups: depGroups } of result.packages ?? []) {
      for (const group of groups) {
        const ids = group.ids ?? [];
        const ofGroup = vulnerabilities.filter(({ id }) => ids.includes(id));
        out.push({
          file,
          name: pkg.name,
          version: pkg.version,
          ids,
          aliases: (group.aliases ?? []).filter((alias) => !ids.includes(alias)),
          severity: group.max_severity || null,
          fixed: fixedVersion(ofGroup, pkg),
          dev: Array.isArray(depGroups) && depGroups.length > 0 && depGroups.every((name) => name === 'dev'),
        });
      }
    }
  }
  return out;
}

/** A path with its links resolved (macOS's /tmp and /var are links), or as it is when it does not exist here. */
function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function describeFinding(finding) {
  const aliases = finding.aliases.length ? ` (${finding.aliases.join(', ')})` : '';
  const severity = finding.severity ? `, severity ${finding.severity}` : '';
  const where = finding.dev ? 'dev only' : 'shipped or unknown';
  const fix = finding.fixed ? `fixed in ${finding.fixed}` : 'no fixed version yet';
  return `${finding.file}: ${finding.name} ${finding.version}, ${finding.ids.join(', ')}${aliases}${severity}, ${where}: ${fix}`;
}

/**
 * The exceptions in osv-scanner.toml: each [[IgnoredVulns]] or [[PackageOverrides]] entry with its id or name, reason
 * and ignoreUntil. Reads only the TOML this file needs (tables of `key = value` lines); OSV-Scanner reads it in full.
 */
export function parseExceptions(text) {
  const entries = [];
  let entry = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const table = /^\[\[\s*([\w.-]+)\s*\]\]$/.exec(line);
    if (table) {
      entry = { table: table[1], line: index + 1, values: {} };
      entries.push(entry);
      return;
    }
    if (line.startsWith('[')) {
      entry = null; // A plain table: nothing of ours.
      return;
    }
    // A key, bare or in quotes, then `=` and its value. Cut at the first `=` rather than matched by one pattern, which
    // backtracks over the spaces around it (Sonar's super-linear-regex).
    const equals = line.indexOf('=');
    const key = line.slice(0, Math.max(equals, 0)).trim();
    if (entry && KEY.test(key)) entry.values[key.replace(/^"|"$/g, '')] = line.slice(equals + 1).trim();
  });
  return entries.map(({ table, line, values }) => ({
    table,
    line,
    id: stringOf(values.id ?? values.name),
    reason: stringOf(values.reason),
    // As written: a date in quotes is a string, which OSV-Scanner does not take for a date.
    ignoreUntil: values.ignoreUntil === undefined ? null : withoutComment(values.ignoreUntil),
  }));
}

/** A TOML string's text, or null for no value or one that is not a string on one line. */
function stringOf(raw) {
  const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(raw?.trim() ?? '');
  if (!quoted) return null;
  return quoted[1] === undefined ? quoted[2] : JSON.parse(`"${quoted[1]}"`);
}

const KEY = /^(?:[\w.-]+|"[^"]*")$/;

/** A value without the comment after it: in TOML a `#` outside a string starts one, and a date is no string. */
const withoutComment = (raw) => {
  const hash = raw.indexOf('#');
  return (hash === -1 ? raw : raw.slice(0, hash)).trim();
};

/** A TOML date: its day, maybe a time after it, and maybe an offset after that; a pattern each, as one would be too complex for Sonar's rules. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;
const OFFSET = /^(?:Z|[+-]\d{2}:\d{2})?$/;

/** Whether what follows the day is a time and maybe an offset, or nothing. */
function isTime(text) {
  if (text === '') return true;
  const clock = TIME.exec(text);
  return clock !== null && OFFSET.test(text.slice(clock[0].length));
}

/** What is wrong with the exceptions: a line for each entry with no reason, no ignoreUntil, or one too far ahead. */
export function problems(exceptions, today = new Date()) {
  const limit = new Date(today.getTime() + MAX_DAYS * 24 * 60 * 60 * 1000);
  const out = [];
  for (const exception of exceptions) {
    const name = `${CONFIG}:${exception.line} ${exception.id ?? `[[${exception.table}]]`}`;
    if (!exception.reason?.trim()) out.push(`${name}: no reason. Say why it does not reach our code, or that no fix is released yet.`);
    if (!exception.ignoreUntil) {
      out.push(`${name}: no ignoreUntil. Give the day it is looked at again, at most ${MAX_DAYS} days ahead (ignoreUntil = 2027-01-31, no quotes).`);
      continue;
    }
    const [day, time] = [exception.ignoreUntil.slice(0, 10), exception.ignoreUntil.slice(10)];
    const date = DAY.test(day) && isTime(time);
    const until = date ? new Date(time ? exception.ignoreUntil : `${day}T00:00:00Z`) : null;
    if (!until || Number.isNaN(until.getTime())) {
      out.push(`${name}: ignoreUntil ${exception.ignoreUntil} is not a TOML date (ignoreUntil = 2027-01-31, no quotes).`);
    } else if (until > limit) {
      out.push(`${name}: ignoreUntil ${exception.ignoreUntil} is more than ${MAX_DAYS} days ahead. Look at it again sooner.`);
    }
  }
  return out;
}

/**
 * Runs the scan of the lock files: 'ok' (nothing found, or no lock files), 'failed' (a finding, a bad exception, an error)
 * or 'skipped' (not installed, outside CI).
 */
export function scan({
  root = process.cwd(), files = lockFilesOf(listFiles(root)), ci = Boolean(process.env.CI), spawn = spawnSync, log = console.error, today = new Date(),
} = {}) {
  const configPath = `${root}/${CONFIG}`;
  const config = existsSync(configPath) ? CONFIG : null;
  const bad = config ? problems(parseExceptions(readFileSync(configPath, 'utf8')), today) : [];
  for (const line of bad) log(`osv: ${line}`);
  if (files.length === 0) {
    log('osv: no lock files here.');
    return bad.length ? 'failed' : 'ok';
  }

  const run = spawn(BIN, args(config, files), { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  if (run.error?.code === 'ENOENT') {
    if (ci) {
      log(`osv: ${BIN} is not in this image. It belongs in the CI's runner image (rm-infra: ops/ci/runner.Dockerfile).`);
      return 'failed';
    }
    log(`osv: ${BIN} is not installed here, so the dependencies went unchecked; the CI's check runs it. To have it here: ${INSTALL}.`);
    return bad.length ? 'failed' : 'skipped';
  }
  if (run.error) throw run.error;
  if (run.status !== 0 && run.status !== 1) {
    log(String(run.stderr ?? '').trim());
    log(`osv: ${BIN} stopped with code ${run.status}, on what it printed above. It asks osv.dev over the network: a failure to reach it is worth one more try.`);
    return 'failed';
  }
  const found = findings(JSON.parse(run.stdout || '{}'), root);
  for (const finding of found) log(`osv: ${describeFinding(finding)}`);
  if (found.length > 0) {
    log([
      '',
      `osv: ${found.length === 1 ? '1 known vulnerability' : `${found.length} known vulnerabilities`} in the dependencies (https://osv.dev/vulnerability/<id>). For each one:`,
      '  - fixed in a version: move to it (package.json for a direct dependency, `npm update <name>` for one that comes through another);',
      `  - no fix yet, or our code never reaches it: write it down in ${CONFIG}, with why and until when (at most ${MAX_DAYS} days ahead):`,
      '      [[IgnoredVulns]]',
      '      id = "<its id>"',
      '      ignoreUntil = <a date, as 2027-01-31>',
      '      reason = "<why>"',
    ].join('\n'));
  } else if (run.status === 1) {
    log(String(run.stderr ?? '').trim());
    log(`osv: ${BIN} found something this script could not read, on what it printed above.`);
    return 'failed';
  }
  if (found.length > 0 || bad.length > 0) return 'failed';
  log(`osv: ${files.join(', ')}: no known vulnerability.`);
  return 'ok';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error('usage: node scripts/osv.mjs');
    process.exit(2);
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  if (scan({ root }) === 'failed') process.exit(1);
}
