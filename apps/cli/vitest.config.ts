import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { vitestConfig } from '@c3-oss/config-vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
  vitestConfig,
  defineConfig({
    resolve: {
      alias: {
        '@c3-oss/prosa-core': path.resolve(moduleDir, '../../packages/prosa-core/src/index.ts'),
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      coverage: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['src/bin/**', 'src/index.ts', 'src/**/*.d.ts'],
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
