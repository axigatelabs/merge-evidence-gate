import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    coverage: {
      enabled: false,
      thresholds: { lines: 90 },
    },
  },
});
