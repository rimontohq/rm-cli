// The config file: each profile's API key, API address and extra headers.
//   $XDG_CONFIG_HOME/rimonto/config.json, else ~/.config/rimonto/config.json; %APPDATA%\rimonto\config.json on Windows
// It holds secrets, so it is written with mode 0600 (its folder 0700 when this creates it).

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { CliError } from './errors.ts';

export interface Profile {
  api_key?: string;
  api_url?: string;
  /** Extra request headers, such as those of a gateway in front of the API. */
  headers?: Record<string, string>;
}

export interface Config {
  profiles: Record<string, Profile>;
}

export const DEFAULT_PROFILE = 'default';

export function configPath(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (platform === 'win32') {
    const base = env.APPDATA || win32.join(home, 'AppData', 'Roaming');
    return win32.join(base, 'rimonto', 'config.json');
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.startsWith('/') ? xdg : join(home, '.config');
  return join(base, 'rimonto', 'config.json');
}

export function readConfig(path: string, warn: (line: string) => void = () => {}): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {} };
    throw new CliError(`cannot read ${path}`, [String((err as Error).message)]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not valid JSON`, ['Fix it by hand, or delete it and run `rimonto login` again.']);
  }
  if (process.platform !== 'win32') {
    try {
      if (statSync(path).mode & 0o077) warn(`warning: ${path} can be read by other users; run: chmod 600 '${path}'`);
    } catch {
      // stat failing right after a read: nothing to warn about
    }
  }
  const profiles = typeof parsed === 'object' && parsed !== null && 'profiles' in parsed ? (parsed as Config).profiles : {};
  return { profiles: typeof profiles === 'object' && profiles !== null ? profiles : {} };
}

/** Writes the whole file through a temporary file in the same folder, so a crash never leaves half a file. */
export function writeConfig(path: string, config: Config): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** `rimonto_sk_…ab12`: enough to tell keys apart, never the secret. */
export function maskKey(key: string): string {
  const prefix = /^(rimonto_sk_|[a-z]+_)/.exec(key)?.[0] ?? '';
  return key.length <= prefix.length + 4 ? `${prefix}…` : `${prefix}…${key.slice(-4)}`;
}
