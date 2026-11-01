import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, maskKey, readConfig, writeConfig } from '../src/config.ts';
import { DEFAULT_API_URL, parseHeader, parseHeadersEnv, resolveContext } from '../src/context.ts';
import { CliError, UsageError } from '../src/errors.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'rimonto-config-'));
const noFlags = { headers: [], json: false, human: false, verbose: false };

describe('the config file', () => {
  it('lives in XDG_CONFIG_HOME, ~/.config or %APPDATA%', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/x/conf' }, 'linux', '/home/ana')).toBe('/x/conf/rimonto/config.json');
    expect(configPath({}, 'darwin', '/Users/ana')).toBe('/Users/ana/.config/rimonto/config.json');
    expect(configPath({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/ana')).toBe('/home/ana/.config/rimonto/config.json');
    expect(configPath({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ana')).toBe('C:\\Users\\ana\\AppData\\Roaming\\rimonto\\config.json');
  });

  it('is written with mode 0600, in a folder with mode 0700', () => {
    const path = join(temp(), 'rimonto', 'config.json');
    writeConfig(path, { profiles: { default: { api_key: 'rimonto_sk_test1234' } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    expect(readConfig(path)).toEqual({ profiles: { default: { api_key: 'rimonto_sk_test1234' } } });
  });

  it('tightens a file that others could read when it writes it, and warns when it reads one', () => {
    const path = join(temp(), 'config.json');
    writeFileSync(path, '{"profiles":{}}');
    chmodSync(path, 0o644);
    const warnings: string[] = [];
    readConfig(path, (l) => warnings.push(l));
    expect(warnings[0]).toMatch(/can be read by other users/);
    writeConfig(path, { profiles: {} });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reads a missing file as empty and refuses a broken one', () => {
    expect(readConfig(join(temp(), 'none.json'))).toEqual({ profiles: {} });
    const path = join(temp(), 'config.json');
    writeFileSync(path, '{nope', { mode: 0o600 });
    expect(() => readConfig(path)).toThrow(CliError);
  });

  it('keeps no temporary file behind', () => {
    const dir = temp();
    writeConfig(join(dir, 'config.json'), { profiles: {} });
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{\n  "profiles": {}\n}\n');
  });

  it('masks a key down to its last four characters', () => {
    expect(maskKey('rimonto_sk_abcdefghijkl1234')).toBe('rimonto_sk_…1234');
    expect(maskKey('rimonto_sk_ab')).toBe('rimonto_sk_…');
  });
});

describe('the context of a request', () => {
  const config = { profiles: { default: { api_key: 'rimonto_sk_default' }, work: { api_key: 'rimonto_sk_work', api_url: 'https://work.example.com/core/', headers: { 'X-Gate': 'profile' } } } };

  it('defaults to production and the default profile', () => {
    expect(resolveContext(noFlags, {}, config)).toMatchObject({ profileName: 'default', apiUrl: DEFAULT_API_URL, apiKey: 'rimonto_sk_default', keySource: 'profile' });
  });

  it('takes the profile from the flag, then RIMONTO_PROFILE', () => {
    expect(resolveContext(noFlags, { RIMONTO_PROFILE: 'work' }, config)).toMatchObject({ profileName: 'work', apiUrl: 'https://work.example.com/core', apiKey: 'rimonto_sk_work' });
    expect(resolveContext({ ...noFlags, profile: 'default' }, { RIMONTO_PROFILE: 'work' }, config).profileName).toBe('default');
  });

  it('lets the flag, then RIMONTO_API_URL, override the profile\'s address, and RIMONTO_API_KEY its key', () => {
    const env = { RIMONTO_PROFILE: 'work', RIMONTO_API_URL: 'http://localhost:5280', RIMONTO_API_KEY: 'rimonto_sk_env' };
    expect(resolveContext(noFlags, env, config)).toMatchObject({ apiUrl: 'http://localhost:5280', apiKey: 'rimonto_sk_env', keySource: 'env' });
    expect(resolveContext({ ...noFlags, apiUrl: 'https://flag.example.com' }, env, config).apiUrl).toBe('https://flag.example.com');
  });

  it('adds headers from the profile, RIMONTO_HEADERS and -H, the later replacing the earlier', () => {
    const ctx = resolveContext({ ...noFlags, profile: 'work', headers: ['x-gate: flag', 'X-Other: 1'] }, { RIMONTO_HEADERS: 'X-Gate: env\nX-Env: 2' }, config);
    expect(ctx.headers).toEqual({ 'X-Env': '2', 'x-gate': 'flag', 'X-Other': '1' });
  });

  it('reads RIMONTO_HEADERS as JSON too', () => {
    expect(parseHeadersEnv('{"CF-Access-Client-Id": "id", "X-N": 1}')).toEqual([['CF-Access-Client-Id', 'id'], ['X-N', '1']]);
  });

  it('refuses a malformed header without echoing its value', () => {
    let err: unknown;
    try {
      parseHeader('supersecretvalue');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UsageError);
    expect(JSON.stringify([(err as UsageError).message, (err as UsageError).hint])).not.toContain('supersecret');
    expect(parseHeader('Name:  a: b ')).toEqual(['Name', 'a: b']);
  });

  it('refuses an address that is not http(s)', () => {
    expect(() => resolveContext({ ...noFlags, apiUrl: 'ftp://x' }, {}, { profiles: {} })).toThrow(UsageError);
    expect(() => resolveContext({ ...noFlags, apiUrl: 'nope' }, {}, { profiles: {} })).toThrow(UsageError);
  });
});
