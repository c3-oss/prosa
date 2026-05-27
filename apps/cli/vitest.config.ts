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
        '@c3-oss/prosa-db-v2': path.resolve(moduleDir, '../../packages/prosa-db-v2/src/index.ts'),
        '@c3-oss/prosa-storage': path.resolve(moduleDir, '../../packages/prosa-storage/src/index.ts'),
        '@c3-oss/prosa-bundle-v2': path.resolve(moduleDir, '../../packages/prosa-bundle-v2/src/index.ts'),
        '@c3-oss/prosa-types-v2': path.resolve(moduleDir, '../../packages/prosa-types-v2/src/index.ts'),
        '@c3-oss/prosa-wire-v2': path.resolve(moduleDir, '../../packages/prosa-wire-v2/src/index.ts'),
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
      // CQ-140: the v1 `sync-e2e.test.ts` and the new Lane 5
      // `sync-v2-e2e.test.ts` both DROP SCHEMA the shared Docker
      // Postgres + reset the MinIO bucket. Run them serialized
      // when any vitest argv mentions e2e so they don't race.
      fileParallelism: !isCoverage && !process.argv.some((arg) => arg.includes('e2e')),
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: isCoverage || process.argv.some((arg) => arg.includes('e2e')),
        },
      },
      testTimeout: isCoverage ? 90_000 : 60_000,
    },
  }),
)
