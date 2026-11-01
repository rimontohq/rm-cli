// Where a request goes and what it carries: the profile, the API address, the key and the extra headers, from
// flags, environment variables and the config file, in that order of precedence.

import { DEFAULT_PROFILE, type Config, type Profile } from './config.ts';
import { UsageError } from './errors.ts';

export const DEFAULT_API_URL = 'https://rimonto.app/core';

export interface GlobalOptions {
  profile?: string;
  apiUrl?: string;
  /** `-H "Name: value"`, in order. */
  headers: string[];
  json: boolean;
  human: boolean;
  verbose: boolean;
  /** Seconds per attempt. */
  timeout?: number;
}

export interface Context {
  profileName: string;
  profile: Profile;
  apiUrl: string;
  apiKey?: string;
  keySource?: 'env' | 'profile';
  /** Extra headers: the profile's, then RIMONTO_HEADERS, then -H (a later one replaces an earlier one of the same name). */
  headers: Record<string, string>;
}

export function resolveContext(opts: GlobalOptions, env: Record<string, string | undefined>, config: Config): Context {
  const profileName = opts.profile || env.RIMONTO_PROFILE || DEFAULT_PROFILE;
  const profile = config.profiles[profileName] ?? {};
  const apiUrl = normalizeUrl(opts.apiUrl || env.RIMONTO_API_URL || profile.api_url || DEFAULT_API_URL);
  const envKey = env.RIMONTO_API_KEY?.trim();
  const apiKey = envKey || profile.api_key || undefined;
  const keySource = envKey ? 'env' : profile.api_key ? 'profile' : undefined;

  const headers: Record<string, string> = {};
  const add = ([name, value]: [string, string]) => {
    for (const k of Object.keys(headers)) if (k.toLowerCase() === name.toLowerCase()) delete headers[k];
    headers[name] = value;
  };
  for (const pair of Object.entries(profile.headers ?? {})) add(pair);
  if (env.RIMONTO_HEADERS?.trim()) for (const pair of parseHeadersEnv(env.RIMONTO_HEADERS)) add(pair);
  for (const h of opts.headers) add(parseHeader(h));

  return { profileName, profile, apiUrl, apiKey, keySource, headers };
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UsageError(`not a valid API address: ${raw}`, 'For example: --api-url https://rimonto.app/core');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`the API address must be http(s): ${raw}`);
  if (url.search || url.hash) throw new UsageError(`the API address cannot have a query or a fragment: ${raw}`);
  return url.toString().replace(/\/+$/, '');
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** `"Name: value"` → `['Name', 'value']`. */
export function parseHeader(raw: string): [string, string] {
  const i = raw.indexOf(':');
  const name = i > 0 ? raw.slice(0, i).trim() : '';
  // The value is never echoed: it is often a secret.
  if (!name || !TOKEN.test(name)) throw new UsageError('a header must look like "Name: value"', 'For example: -H "X-Request-Source: my-script"');
  return [name, raw.slice(i + 1).trim()];
}

/** RIMONTO_HEADERS: a JSON object, or one `Name: value` per line. */
export function parseHeadersEnv(raw: string): [string, string][] {
  const text = raw.trim();
  if (text.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new UsageError('RIMONTO_HEADERS is not valid JSON', 'Use a JSON object, or one "Name: value" per line.');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new UsageError('RIMONTO_HEADERS must be a JSON object');
    return Object.entries(obj).map(([k, v]) => {
      const [name] = parseHeader(`${k}: x`);
      return [name, String(v)];
    });
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parseHeader);
}
