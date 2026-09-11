import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // node:sqlite в Node 22 доступен только под флагом.
    poolOptions: { threads: { execArgv: ['--experimental-sqlite'] } },
  },
});
