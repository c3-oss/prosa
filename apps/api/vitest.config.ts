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
        '@c3-oss/prosa-db': path.resolve(moduleDir, '../../packages/prosa-db/src/index.ts'),
        '@c3-oss/prosa-db-v2': path.resolve(moduleDir, '../../packages/prosa-db-v2/src/index.ts'),
        '@c3-oss/prosa-storage': path.resolve(moduleDir, '../../packages/prosa-storage/src/index.ts'),
        '@c3-oss/prosa-sync': path.resolve(moduleDir, '../../packages/prosa-sync/src/index.ts'),
        '@c3-oss/prosa-bundle-v2': path.resolve(moduleDir, '../../packages/prosa-bundle-v2/src/index.ts'),
        '@c3-oss/prosa-types-v2': path.resolve(moduleDir, '../../packages/prosa-types-v2/src/index.ts'),
        '@c3-oss/prosa-wire-v2': path.resolve(moduleDir, '../../packages/prosa-wire-v2/src/index.ts'),
      },
    },
    test: {
      include: ['test/**/*.test.ts', 'test/**/*.e2e.test.ts'],
      environment: 'node',
      coverage: {
        include: ['src/**/*.ts'],
        exclude: ['src/bin/**', 'src/index.ts', 'src/**/*.d.ts'],
        cleanOnRerun: false,
      },
      // CQ-140: the e2e files (`test/e2e/*.e2e.test.ts`) both
      // `DROP SCHEMA public CASCADE; CREATE SCHEMA public` on the
      // shared Docker Postgres and share the same MinIO bucket. If
      // they run in parallel they race and produce duplicate-type
      // errors. Vitest >= 1 doesn't expose per-file
      // fileParallelism overrides, so when any e2e file is in the
      // test set we fall back to a single worker. The non-e2e
      // suite (the bulk of fast PGlite-backed cases) keeps the
      // parallel default.
      fileParallelism: !isCoverage && !process.argv.some((arg) => arg.includes('e2e')),
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: process.argv.some((arg) => arg.includes('e2e')),
        },
      },
      testTimeout: isCoverage ? 120_000 : 30_000,
    },
  }),
)
