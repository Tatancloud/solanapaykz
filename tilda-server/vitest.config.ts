import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // node:sqlite не требует флага с Node 22.13 (см. заголовок src/db.ts) —
    // engines.node в package.json поднят до >=22.13.0 именно поэтому, так
    // что здесь флаг больше не нужен ни одной поддерживаемой версии Node.
  },
});
