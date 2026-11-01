import { describe, expect, it, vi } from 'vitest';
import { LATEST_URL, checkEnabled, isNewer, startUpdateCheck, type UpdateIo } from '../src/update-check.ts';

const DAY = 24 * 60 * 60 * 1000;

/** A terminal session with a state file in memory and npm answering `latest`. */
function session(latest: string | Error, opts: { env?: Record<string, string | undefined>; tty?: boolean; file?: string; now?: number } = {}) {
  let file = opts.file;
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) => {
    if (latest instanceof Error) throw latest;
    expect(url).toBe(LATEST_URL);
    return new Response(JSON.stringify({ name: 'rimonto', version: latest }), { status: 200 });
  });
  const io: UpdateIo = {
    env: opts.env ?? {},
    stderrIsTTY: opts.tty ?? true,
    now: () => opts.now ?? 1_800_000_000_000,
    fetch: fetch as unknown as typeof globalThis.fetch,
    read: () => file,
    write: (text) => {
      file = text;
    },
  };
  return { io, fetch, file: () => (file ? JSON.parse(file) : undefined) };
}

describe('the update notice', () => {
  it('compares x.y.z versions, and never calls a pre-release or a malformed one newer', () => {
    expect(isNewer('0.1.2', '0.1.1')).toBe(true);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('0.2.0-beta.1', '0.1.1')).toBe(false);
    expect(isNewer('latest', '0.1.1')).toBe(false);
    expect(isNewer('0.1.1', '0.1.1-dev')).toBe(false);
  });

  it('stays quiet in CI, in a pipe and when switched off, without asking npm', async () => {
    for (const opts of [{ env: { CI: 'true' } }, { tty: false }, { env: { RIMONTO_NO_UPDATE_CHECK: '1' } }, { env: { NO_UPDATE_NOTIFIER: '1' } }]) {
      const s = session('9.9.9', opts);
      expect(checkEnabled(s.io)).toBe(false);
      expect(await startUpdateCheck('0.1.1', s.io)()).toBe('');
      expect(s.fetch).not.toHaveBeenCalled();
      expect(s.file()).toBeUndefined();
    }
  });

  it('says so once when npm has a newer version, and keeps what it learned', async () => {
    const s = session('0.1.2');
    const notice = await startUpdateCheck('0.1.1', s.io)();
    expect(notice).toContain('A new version of rimonto is out: 0.1.2 (this is 0.1.1).');
    expect(notice).toContain('npm install -g rimonto, or brew upgrade rimonto');
    expect(s.file()).toEqual({ checkedAt: 1_800_000_000_000, latest: '0.1.2', notifiedAt: 1_800_000_000_000 });
  });

  it('asks npm at most once a day and repeats the notice at most once a day', async () => {
    const first = session('0.1.2');
    await startUpdateCheck('0.1.1', first.io)();
    const file = JSON.stringify(first.file());

    const later = session('0.1.2', { file, now: 1_800_000_000_000 + DAY / 2 });
    expect(await startUpdateCheck('0.1.1', later.io)()).toBe('');
    expect(later.fetch).not.toHaveBeenCalled();

    const tomorrow = session('0.1.3', { file, now: 1_800_000_000_000 + DAY + 1 });
    expect(await startUpdateCheck('0.1.1', tomorrow.io)()).toContain('is out: 0.1.3');
    expect(tomorrow.fetch).toHaveBeenCalledTimes(1);
  });

  it('says nothing when this is the latest version, or a later one', async () => {
    expect(await startUpdateCheck('0.1.2', session('0.1.2').io)()).toBe('');
    expect(await startUpdateCheck('0.2.0', session('0.1.2').io)()).toBe('');
  });

  it('never fails the command: offline, a broken state file, a home it cannot write', async () => {
    const offline = session(new TypeError('fetch failed'));
    expect(await startUpdateCheck('0.1.1', offline.io)()).toBe('');
    expect(offline.file()).toEqual({ checkedAt: 1_800_000_000_000 });

    const broken = session('0.1.2', { file: '{not json' });
    expect(await startUpdateCheck('0.1.1', broken.io)()).toContain('is out: 0.1.2');

    const readOnly = session('0.1.2');
    readOnly.io.write = () => {
      throw new Error('EROFS');
    };
    expect(await startUpdateCheck('0.1.1', readOnly.io)()).toContain('is out: 0.1.2');
  });
});
