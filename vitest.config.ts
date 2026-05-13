import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin/**', 'src/cli/**', 'src/tui/**', 'src/index.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    testTimeout: 20_000,
  },
})
