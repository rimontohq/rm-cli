import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Times print in the reader's time zone: the tests read them in one.
    env: { TZ: 'UTC' },
  },
});
