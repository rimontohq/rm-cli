import { describe, expect, it } from 'vitest';
import type { HttpResponse } from '../src/http.ts';
import { describeFailure } from '../src/problem.ts';

function res(status: number, body: unknown, contentType = 'application/problem+json', headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, statusText: '', headers: new Headers(headers), contentType, text, json: typeof body === 'string' ? undefined : body, replayed: false, attempts: 1 };
}
const ctx = { apiUrl: 'https://rimonto.app/core' };

describe('describeFailure', () => {
  it('shows a problem: title, status and code, then the detail and the extra fields', () => {
    const lines = describeFailure(res(422, { type: 'urn:rimonto:problem:payments-do-not-match', title: 'Payments do not add up', status: 422, code: 'payments-do-not-match', detail: 'The payments must cover the total.', due_minor: 2176 }), ctx);
    expect(lines).toEqual(['rimonto: Payments do not add up (422 payments-do-not-match)', '  The payments must cover the total.', '  due_minor: 2176']);
  });

  it('lists validation issues', () => {
    const lines = describeFailure(res(400, { title: 'Invalid body', status: 400, code: 'invalid-request', issues: [{ path: 'status', message: 'Invalid option' }] }), ctx);
    expect(lines).toEqual(['rimonto: Invalid body (400 invalid-request)', '  issues:', '    - status: Invalid option']);
    const odd = describeFailure(res(400, { title: 'Invalid body', status: 400, issues: [{ path: ['a', 1], message: { text: 'x' } }] }), ctx);
    expect(odd.at(-1)).toBe('    - {"path":["a",1],"message":{"text":"x"}}');
  });

  it('says how to sign in after a 401', () => {
    const body = { title: 'Not signed in', status: 401, code: 'unauthenticated' };
    expect(describeFailure(res(401, body), ctx).at(-1)).toBe('Run `rimonto login` to sign in.');
    expect(describeFailure(res(401, body), { ...ctx, profileName: 'work' }).at(-1)).toBe('Run `rimonto login --profile work` to sign in.');
    expect(describeFailure(res(401, body), { ...ctx, keySource: 'env' }).at(-1)).toMatch(/^RIMONTO_API_KEY is set/);
  });

  it('explains a command that needs a person', () => {
    const lines = describeFailure(res(403, { title: 'Not with an API key', status: 403, code: 'api-key-not-allowed', detail: 'A person signs in for this.' }), ctx);
    expect(lines[0]).toBe('rimonto: Not with an API key (403 api-key-not-allowed)');
    expect(lines.at(-1)).toMatch(/needs a person's own sign-in/);
  });

  it('gives the idempotency key after a 5xx', () => {
    const lines = describeFailure(res(503, { title: 'Supplier unavailable', status: 503, code: 'supplier-unavailable' }), { ...ctx, idempotencyKey: 'k-9' });
    expect(lines).toContain('It is safe to run it again with --idempotency-key k-9');
  });

  it('recognises a web page or a redirect in front of the API', () => {
    expect(describeFailure(res(403, '<html>Sign in</html>', 'text/html; charset=utf-8'), ctx)[0]).toMatch(/the answer is a web page, not the API/);
    const lines = describeFailure(res(302, '', 'text/plain', { location: 'https://login.example.com/x?token=long&meta=more' }), ctx);
    expect(lines[0]).toBe('rimonto: the API address redirects (302 to https://login.example.com/x)');
    expect(lines[2]).toMatch(/sign-in page in front of the API/);
  });

  it('shows the text of an answer that is not a problem', () => {
    expect(describeFailure(res(500, 'oops', 'text/plain'), ctx)).toEqual(['rimonto: 500', '  oops']);
  });
});
