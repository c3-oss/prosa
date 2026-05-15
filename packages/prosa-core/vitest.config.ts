import { vitestConfig } from '@c3-oss/config-vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

export default mergeConfig(
  vitestConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      coverage: {
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.d.ts', 'src/**/types.ts'],
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
