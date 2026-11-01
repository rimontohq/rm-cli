// Tells a person, at most once a day, that a newer rimonto is on npm, so fixes reach them. It asks npm's registry while
// the command runs, never fails the command and delays it by a second at most, once a day. It stays quiet in CI, when
// stderr is not a terminal, and with RIMONTO_NO_UPDATE_CHECK (or NO_UPDATE_NOTIFIER) set. What it learned is kept next
// to the config file (update-check.json): two times and a version number, nothing about the person.

export const LATEST_URL = 'https://registry.npmjs.org/rimonto/latest';
const DAY = 24 * 60 * 60 * 1000;

export interface UpdateState {
  checkedAt?: number;
  latest?: string;
  notifiedAt?: number;
}

export interface UpdateIo {
  env: Record<string, string | undefined>;
  stderrIsTTY: boolean;
  now: () => number;
  fetch: typeof fetch;
  /** The state file's text; undefined when there is none. */
  read: () => string | undefined;
  write: (text: string) => void;
}

const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);

/** Whether `a` is a later x.y.z than `b`. A pre-release or anything malformed is never later. */
export function isNewer(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b.replace(/-.*$/, ''));
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export function checkEnabled(io: Pick<UpdateIo, 'env' | 'stderrIsTTY'>): boolean {
  const { env } = io;
  return io.stderrIsTTY && !env.RIMONTO_NO_UPDATE_CHECK && !env.NO_UPDATE_NOTIFIER && !env.CI;
}

/**
 * Starts the check before the command runs. The function it returns, awaited after the command, gives the notice to
 * print on stderr, or '' (and saves what it learned).
 */
export function startUpdateCheck(current: string, io: UpdateIo, timeoutMs = 1000): () => Promise<string> {
  if (!checkEnabled(io)) return async () => '';
  let state: UpdateState = {};
  try {
    const text = io.read();
    if (text) state = JSON.parse(text) as UpdateState;
  } catch {
    state = {};
  }
  const now = io.now();
  const due = !state.checkedAt || now - state.checkedAt > DAY;
  const asked = due
    ? (async () => {
        try {
          const res = await io.fetch(LATEST_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
          const version = res.ok ? ((await res.json()) as { version?: unknown }).version : undefined;
          if (typeof version === 'string') state = { ...state, latest: version };
        } catch {
          // offline, slow or blocked: no notice today
        }
        state = { ...state, checkedAt: now };
      })()
    : Promise.resolve();

  return async () => {
    await asked;
    const notify = !!state.latest && isNewer(state.latest, current) && (!state.notifiedAt || now - state.notifiedAt > DAY);
    if (notify) state = { ...state, notifiedAt: now };
    if (due || notify) {
      try {
        io.write(`${JSON.stringify(state)}\n`);
      } catch {
        // a read-only home: the check runs again next time
      }
    }
    return notify
      ? `\nA new version of rimonto is out: ${state.latest} (this is ${current}).\nUpdate: npm install -g rimonto, or brew upgrade rimonto.\n`
      : '';
  };
}
