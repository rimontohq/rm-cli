// The built bundle, as npm and Homebrew ship it: dist/rimonto.js, run by `node` as a separate process. It is built
// here, then copied alone into an empty folder, so it must run with no node_modules beside it. No network.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { TABLE } from '../src/generated/commands.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const alone = mkdtempSync(join(tmpdir(), 'rimonto-smoke-'));
const bundle = join(alone, 'rimonto.js');

/** Only what the CLI needs: no RIMONTO_* of the person running the tests, an empty config, an API that is not there. */
const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  HOME: alone,
  XDG_CONFIG_HOME: join(alone, 'config'),
  APPDATA: join(alone, 'config'),
  RIMONTO_API_URL: 'http://127.0.0.1:9',
};

function rimonto(...args: string[]) {
  const r = spawnSync(process.execPath, [bundle, ...args], { cwd: alone, env, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  const build = spawnSync(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  if (build.status !== 0) throw new Error(`the build failed: ${build.stderr}`);
  copyFileSync(join(root, 'dist/rimonto.js'), bundle);
}, 60_000);

describe('dist/rimonto.js', () => {
  it('prints its version: the package\'s, and the API\'s', () => {
    const r = rimonto('--version');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`rimonto ${version} (API ${TABLE.apiVersion})\n`);
  });

  it('lists the areas', () => {
    const r = rimonto('--help');
    expect(r.code).toBe(0);
    for (const area of TABLE.areas) expect(r.stdout).toContain(area.name);
  });

  it('shows a group\'s commands and one command\'s flags', () => {
    const group = rimonto('tickets', '--help');
    expect(group.code).toBe(0);
    expect(group.stdout).toContain('tickets list');
    expect(group.stdout).toContain('tickets set-status <id>');
    const one = rimonto('tickets', 'list', '--help');
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('rimonto tickets list [flags]');
    expect(one.stdout).toContain('--status');
    expect(one.stdout).toContain('--all');
  });

  it('refuses an unknown command with exit 64 and a suggestion', () => {
    const r = rimonto('tickts', 'list');
    expect(r.code).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command "rimonto tickts"');
    expect(r.stderr).toContain('Did you mean `rimonto tickets`?');
  });
});
