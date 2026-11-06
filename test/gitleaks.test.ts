// Secret scanning (scripts/gitleaks.mjs): which commits each mode reads, and that a key staged in a repository is stopped
// without its value being printed.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, no types
import { argsFor, gitleaks } from '../scripts/gitleaks.mjs';

describe('the modes', () => {
  it('read what a commit adds, the branch, or the whole history; anything else goes to gitleaks as it is', () => {
    expect(argsFor('staged', [])).toEqual(expect.arrayContaining(['git', '--pre-commit', '--staged', '--redact']));
    expect(argsFor('branch', [], () => 'origin/dev..HEAD').slice(0, 2)).toEqual(['git', '--log-opts=origin/dev..HEAD']);
    expect(argsFor('branch', [], () => null).slice(0, 2)).toEqual(['dir', '.']);
    expect(argsFor('history', [])[0]).toBe('git');
    expect(argsFor('version', [])).toEqual(['version']);
    for (const mode of ['staged', 'branch', 'history']) expect(argsFor(mode, [], () => null)).toContain('--redact');
  });
});

describe('a key in a commit', () => {
  it('is stopped before the commit, and its value is not printed', { timeout: 60_000 }, async () => {
    await gitleaks(); // downloaded and checked once
    const repo = mkdtempSync(join(tmpdir(), 'gitleaks-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...args]);
    git('init', '-q', '-b', 'dev');
    copyFileSync('.gitleaks.toml', join(repo, '.gitleaks.toml'));
    const key = `rimonto_sk_${randomBytes(30).toString('base64').replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 40).padEnd(40, 'Q')}`;
    writeFileSync(join(repo, 'client.ts'), `export const key = '${key}';\n`);
    git('add', '-A');
    const run = spawnSync(process.execPath, [join(process.cwd(), 'scripts/gitleaks.mjs'), 'staged'], { cwd: repo, encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('rimonto-api-key');
    expect(`${run.stdout}${run.stderr}`).not.toContain(key);
    rmSync(repo, { recursive: true, force: true });
  });
});
