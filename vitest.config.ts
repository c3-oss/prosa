import { vitestConfig } from '@c3-oss/config-vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

// The shared config sets passWithNoTests + v8 coverage reporter/excludes;
// prosa overlays the project-specific include, node environment, coverage
// scope/thresholds, fork pool, and a longer test timeout.
export default mergeConfig(
  vitestConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      coverage: {
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
  }),
)
