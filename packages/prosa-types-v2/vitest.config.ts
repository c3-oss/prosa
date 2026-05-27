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
        exclude: ['src/**/*.d.ts', 'src/index.ts', 'src/entities/**'],
      },
      pool: 'forks',
      poolOptions: { forks: { singleFork: false } },
      testTimeout: 20_000,
    },
  }),
)
