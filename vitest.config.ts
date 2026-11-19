import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'scripts/__tests__/**/*.test.ts',
      '{apps,services,packages}/*/src/**/*.test.{ts,tsx}',
      '{apps,services,packages}/*/test/**/*.test.{ts,tsx}',
    ],
    passWithNoTests: true,
    // guardrail tests spawn git + node hooks in temp repositories; slow on Windows
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
