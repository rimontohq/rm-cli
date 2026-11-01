// Exit codes, and the errors that carry them to src/cli.ts.
//   0 done · 1 the API refused, or a local problem (config, sign-in) · 2 the API could not be reached · 64 usage

export const EXIT = { ok: 0, failed: 1, network: 2, usage: 64, interrupted: 130 } as const;

/** The command line is wrong: a missing argument, an unknown flag, a value of the wrong type. */
export class UsageError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/** Anything else that stops a command, with the lines to print and the exit code. */
export class CliError extends Error {
  readonly code: number;
  readonly lines: string[];
  constructor(message: string, lines: string[] = [], code: number = EXIT.failed) {
    super(message);
    this.lines = lines;
    this.code = code;
  }
}

/** No answer from the API: the connection failed or timed out on every attempt. */
export class NetworkError extends Error {
  readonly url: string;
  readonly reason: string;
  readonly idempotencyKey: string | undefined;
  constructor(url: string, reason: string, idempotencyKey?: string) {
    super(`could not reach ${url} (${reason})`);
    this.url = url;
    this.reason = reason;
    this.idempotencyKey = idempotencyKey;
  }
}
