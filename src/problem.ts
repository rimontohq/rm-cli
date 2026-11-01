// An error answer, for people, on stderr. The API's errors are application/problem+json with a stable `code`:
//   rimonto: Not with an API key (403 api-key-not-allowed)
//     A person signs in for this.
// then any extra fields, then what to do about it.

import type { HttpResponse } from './http.ts';

export interface ProblemContext {
  apiUrl: string;
  keySource?: 'env' | 'profile';
  profileName?: string;
  idempotencyKey?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STANDARD = new Set(['type', 'title', 'status', 'code', 'detail', 'instance']);

export function describeFailure(res: HttpResponse, ctx: ProblemContext): string[] {
  const lines: string[] = [];
  const body = res.json;
  const isProblem = isObj(body) && typeof body.title === 'string';
  if (isProblem) {
    const code = typeof body.code === 'string' ? ` ${body.code}` : '';
    lines.push(`rimonto: ${body.title} (${res.status}${code})`);
    if (typeof body.detail === 'string' && body.detail) lines.push(`  ${body.detail}`);
    for (const [k, v] of Object.entries(body)) {
      if (STANDARD.has(k)) continue;
      if (k === 'issues' && Array.isArray(v)) {
        lines.push('  issues:');
        for (const issue of v) {
          if (isObj(issue)) lines.push(`    - ${issue.path ? `${String(issue.path)}: ` : ''}${String(issue.message ?? JSON.stringify(issue))}`);
          else lines.push(`    - ${JSON.stringify(issue)}`);
        }
      } else lines.push(`  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  } else if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    lines.push(`rimonto: the API address redirects (${res.status}${location ? ` to ${location}` : ''})`);
    lines.push(`  Requests go to ${ctx.apiUrl}. If the new address is right, use it: --api-url or RIMONTO_API_URL.`);
    if (location && !sameOrigin(location, ctx.apiUrl)) {
      lines.push('  A redirect to another site can be a sign-in page in front of the API: pass its headers with -H or RIMONTO_HEADERS.');
    }
    return lines;
  } else if (/text\/html/i.test(res.contentType)) {
    lines.push(`rimonto: the answer is a web page, not the API (${res.status} ${res.statusText})`);
    lines.push(`  Is ${ctx.apiUrl} the API's address? If a sign-in page stands in front of it, pass its headers with -H or RIMONTO_HEADERS.`);
    return lines;
  } else {
    lines.push(`rimonto: ${res.status} ${res.statusText}`.trimEnd());
    const text = res.text.trim();
    if (text) lines.push(`  ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`);
  }

  const code = isProblem ? body.code : undefined;
  if (res.status === 401) {
    if (ctx.keySource === 'env') lines.push('RIMONTO_API_KEY is set: check its value, or unset it to use the key stored by `rimonto login`.');
    else lines.push(`Run \`rimonto login${ctx.profileName && ctx.profileName !== 'default' ? ` --profile ${ctx.profileName}` : ''}\` to sign in.`);
  } else if (code === 'api-key-not-allowed') {
    lines.push("This command needs a person's own sign-in; an API key cannot run it. Signing in with a browser comes in a later version of rimonto.");
  }
  if (ctx.idempotencyKey && (res.status === 429 || res.status >= 500)) lines.push(...retryHint(ctx.idempotencyKey));
  return lines;
}

/** After a failure that may have left a command half-known: how to retry it without doing it twice. */
export function retryHint(key: string): string[] {
  return [
    `It is safe to run it again with --idempotency-key ${key}`,
    '  If the first attempt went through, the API answers with its result instead of doing it twice.',
  ];
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a, b).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
