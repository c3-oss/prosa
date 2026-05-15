import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { vitestConfig } from '@c3-oss/config-vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const isCoverage = process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage.'))

export default mergeConfig(
  vitestConfig,
  defineConfig({
    resolve: {
      alias: {
        '@c3-oss/prosa-core': path.resolve(moduleDir, '../../packages/prosa-core/src/index.ts'),
        '@c3-oss/prosa-sync': path.resolve(moduleDir, '../../packages/prosa-sync/src/index.ts'),
        '@c3-oss/prosa-api': path.resolve(moduleDir, '../api/src/index.ts'),
        '@c3-oss/prosa-db': path.resolve(moduleDir, '../../packages/prosa-db/src/index.ts'),
        '@c3-oss/prosa-storage': path.resolve(moduleDir, '../../packages/prosa-storage/src/index.ts'),
      },
    },
    test: {
      include: ['test/**/*.test.ts'],
      environment: 'node',
      coverage: {
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        exclude: ['src/bin/**', 'src/index.ts', 'src/**/*.d.ts'],
        cleanOnRerun: false,
      },
      fileParallelism: !isCoverage,
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: isCoverage,
        },
      },
      testTimeout: isCoverage ? 90_000 : 20_000,
    },
  }),
)
