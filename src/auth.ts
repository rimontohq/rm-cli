// rimonto login, logout and auth status: API keys kept per profile in the config file, checked with GET /whoami.

import type { ParsedLine } from './args.ts';
import type { Session } from './cli.ts';
import { maskKey, readConfig, writeConfig, type Profile } from './config.ts';
import { DEFAULT_API_URL, normalizeUrl, parseHeader } from './context.ts';
import { CliError, EXIT, UsageError } from './errors.ts';
import type { HttpResponse } from './http.ts';
import { describeFailure } from './problem.ts';
import { readAll, readHidden } from './prompt.ts';

/** GET /whoami's answer (the fields this file reads). */
export interface Caller {
  kind?: 'person' | 'api_key';
  company_id?: string | null;
  role?: string | null;
  roles?: string[];
  all_stores?: boolean;
  store_ids?: string[];
  api_key?: { id: string; name: string; title: string } | null;
}

const PORTAL = 'https://developers.rimonto.app';

/** What a key acts as, as label/value lines; stores by name when `storeNames` has them. */
export function describeCaller(w: Caller, storeNames: Map<string, string> = new Map()): [string, string][] {
  const out: [string, string][] = [];
  if (w.kind === 'api_key' && w.api_key) out.push(['Key name', w.api_key.name]);
  else if (w.kind === 'person') out.push(['Signed in', 'as a person']);
  const role = [w.role, w.api_key?.title].filter(Boolean).join(', ');
  if (role) out.push(['Role', role]);
  if (w.roles?.length) out.push(['May do', `what ${w.roles.join(', ')} may`]);
  if (w.company_id) out.push(['Company', w.company_id]);
  if (w.all_stores) out.push(['Stores', 'all stores, today\'s and new ones']);
  else if (w.store_ids?.length === 1) out.push(['Store', storeNames.get(w.store_ids[0]!) ?? w.store_ids[0]!]);
  else if (w.store_ids) out.push(['Stores', w.store_ids.length ? w.store_ids.map((id) => storeNames.get(id) ?? id).join('; ') : 'none']);
  return out;
}

const lines = (pairs: [string, string][], indent = '') => {
  const w = Math.max(...pairs.map(([l]) => l.length));
  return pairs.map(([l, v]) => `${indent}${l.padEnd(w)}  ${v}`);
};

const ok = (res: HttpResponse) => res.status >= 200 && res.status < 300;

/** `/Users/ana/.config/rimonto/config.json` → `~/.config/rimonto/config.json`. */
export function tildePath(path: string, home: string): string {
  if (!home) return path;
  const h = home.replace(/[\\/]+$/, '');
  return path === h ? '~' : path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path;
}

/** The names of a key's stores (`Fix-It Lab, Brooklyn`) from GET /stores; none when the API has no such read. */
async function storeNamesFor(s: Session, key: string, w: Caller): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (w.all_stores || !w.store_ids?.length) return names;
  try {
    const res = await s.call({ method: 'GET', path: '/stores', apiKey: key });
    const stores = ok(res) && typeof res.json === 'object' && res.json !== null ? (res.json as { stores?: unknown }).stores : undefined;
    if (Array.isArray(stores)) {
      for (const st of stores as { id?: string; name?: string; city?: string }[]) {
        if (st.id && st.name) names.set(st.id, st.city ? `${st.name}, ${st.city}` : st.name);
      }
    }
  } catch {
    // the ids will do
  }
  return names;
}

export async function login(s: Session, line: ParsedLine): Promise<number> {
  if (line.positionals.length) throw new UsageError(`unexpected argument "${line.positionals[0]}"`, 'Usage: rimonto login [--with-key] [--profile <name>]');
  const { io, ctx } = s;
  let key: string;
  const asked = !line.occurrences.some((o) => o.name === 'with-key');
  if (!asked) {
    key = (await readAll(io.stdin)).trim();
  } else if (io.stdin.isTTY) {
    io.stderr.write(`Signing in to ${ctx.apiUrl} (profile "${ctx.profileName}").\n`);
    io.stderr.write(`An owner makes keys at ${PORTAL} → API keys.\n`);
    key = (await readHidden('API key: ', io.stdin, io.stderr)).trim();
  } else {
    throw new UsageError('there is no terminal to ask for the key', 'Pipe it in instead: rimonto login --with-key < key.txt');
  }
  if (!key) throw new UsageError('no key given');
  if (/\s/.test(key)) throw new UsageError('a key has no spaces in it: check what was pasted');
  if (!key.startsWith('rimonto_sk_')) s.err('warning: this does not look like a Rimonto API key (rimonto_sk_…); trying it anyway');

  const res = await s.call({ method: 'GET', path: '/whoami', apiKey: key });
  if (!ok(res)) {
    if (res.status === 401) {
      throw new CliError(`${ctx.apiUrl} refused this key (401)`, [`Check it, or make a new one in the developer portal, ${PORTAL}. Nothing was saved.`]);
    }
    for (const l of describeFailure(res, { apiUrl: ctx.apiUrl })) s.err(l);
    s.err('Nothing was saved.');
    return EXIT.failed;
  }

  // Read again just before writing, so a login in another terminal is not undone.
  const config = readConfig(s.configPath);
  const profile: Profile = { ...config.profiles[ctx.profileName], api_key: key };
  // The profile remembers where its key works.
  if (ctx.apiUrl === DEFAULT_API_URL) delete profile.api_url;
  else profile.api_url = normalizeUrl(ctx.apiUrl);
  if (s.globals.headers.length) {
    profile.headers = { ...profile.headers, ...Object.fromEntries(s.globals.headers.map(parseHeader)) };
  }
  config.profiles[ctx.profileName] = profile;
  writeConfig(s.configPath, config);

  if (s.mode === 'json') {
    s.out(JSON.stringify({ profile: ctx.profileName, api_url: ctx.apiUrl, key: maskKey(key), whoami: res.json }, null, 2));
  } else {
    // When it asked for the key, the first line already named the address and the profile.
    s.out(asked ? `Signed in with ${maskKey(key)}.` : `Signed in to ${ctx.apiUrl} with ${maskKey(key)} (profile "${ctx.profileName}").`);
    const caller = (res.json ?? {}) as Caller;
    for (const l of lines(describeCaller(caller, await storeNamesFor(s, key, caller)), '  ')) s.out(l);
    s.out(`Saved in ${tildePath(s.configPath, io.homedir)}${s.globals.headers.length ? `, with ${s.globals.headers.length} extra header(s)` : ''}.`);
  }
  if (ctx.keySource === 'env') s.err('Note: RIMONTO_API_KEY is set, and it is used instead of the saved key while it is.');
  return EXIT.ok;
}

export async function logout(s: Session): Promise<number> {
  const config = readConfig(s.configPath);
  const name = s.ctx.profileName;
  const profile = config.profiles[name];
  if (!profile?.api_key) throw new CliError(`profile "${name}" has no key saved`);
  delete profile.api_key;
  if (!Object.keys(profile).length) delete config.profiles[name];
  writeConfig(s.configPath, config);
  s.out(`Signed out of profile "${name}": its key is removed from ${tildePath(s.configPath, s.io.homedir)}.`);
  s.out('The key itself keeps working until an owner revokes it in the developer portal (API keys).');
  if (s.ctx.keySource === 'env') s.err('Note: RIMONTO_API_KEY is still set, and commands use it.');
  return EXIT.ok;
}

interface StatusEntry {
  name: string;
  active: boolean;
  api_url: string;
  key?: string;
  source: 'env' | 'profile';
  ok?: boolean;
  whoami?: unknown;
  error?: string;
}

export async function authStatus(s: Session): Promise<number> {
  const { ctx, config, io } = s;
  const envKey = io.env.RIMONTO_API_KEY?.trim();
  const entries: { entry: StatusEntry; key?: string; headers: Record<string, string> }[] = [];
  if (envKey) {
    entries.push({ entry: { name: 'RIMONTO_API_KEY', active: true, api_url: ctx.apiUrl, key: maskKey(envKey), source: 'env' }, key: envKey, headers: ctx.headers });
  }
  const names = Object.keys(config.profiles);
  if (!names.includes(ctx.profileName)) names.unshift(ctx.profileName);
  names.sort((a, b) => Number(b === ctx.profileName) - Number(a === ctx.profileName) || a.localeCompare(b));
  for (const name of names) {
    const p = config.profiles[name] ?? {};
    const active = name === ctx.profileName;
    entries.push({
      entry: { name, active: active && !envKey, api_url: active ? ctx.apiUrl : normalizeUrl(p.api_url ?? DEFAULT_API_URL), key: p.api_key ? maskKey(p.api_key) : undefined, source: 'profile' },
      key: p.api_key,
      headers: active ? ctx.headers : { ...p.headers },
    });
  }

  await Promise.all(entries.map(async (e) => {
    if (!e.key) return;
    try {
      const res = await s.call({ method: 'GET', path: '/whoami', apiKey: e.key, apiUrl: e.entry.api_url, headers: e.headers });
      e.entry.ok = ok(res);
      if (ok(res)) e.entry.whoami = res.json;
      else e.entry.error = describeFailure(res, { apiUrl: e.entry.api_url })[0]!.replace(/^rimonto: /, '');
    } catch (err) {
      e.entry.ok = false;
      e.entry.error = (err as Error).message;
    }
  }));

  const inUse = entries.find((e) => e.entry.active || (e.entry.source === 'env'))?.entry;
  if (s.mode === 'json') {
    s.out(JSON.stringify(entries.map((e) => e.entry), null, 2));
  } else {
    for (const { entry } of entries) {
      s.out(`${entry.name}${entry.active ? ' (in use)' : entry.name === ctx.profileName && envKey ? ' (RIMONTO_API_KEY is used instead)' : ''}`);
      const pairs: [string, string][] = [['API', entry.api_url], ['Key', entry.key ?? 'none: run `rimonto login' + (entry.name === 'default' ? '' : ` --profile ${entry.name}`) + '`']];
      if (entry.whoami) pairs.push(...describeCaller(entry.whoami));
      if (entry.error) pairs.push(['Error', entry.error]);
      for (const l of lines(pairs, '  ')) s.out(l);
    }
  }
  return inUse?.ok ? EXIT.ok : EXIT.failed;
}
