// The CLI's version: put in by the build (scripts/build.ts), read from package.json when run from source.

import { readFileSync } from 'node:fs';

declare const RIMONTO_VERSION: string | undefined;

function fromPackage(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION: string = typeof RIMONTO_VERSION === 'string' ? RIMONTO_VERSION : fromPackage();
