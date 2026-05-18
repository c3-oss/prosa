// Workspace-root Vitest configuration.
//
// This config scopes to cross-package tests under `test/`. Package-local
// tests still run via each package's own `vitest.config.ts` through Turbo.
//
// Used by:
//   - Lane 0 conformance gate: `pnpm test:conformance`
//   - Future cross-cutting fixture tests under `test/`.

import { vitestConfig } from '@c3-oss/config-vitest'
import { defineConfig, mergeConfig } from 'vitest/config'

export default mergeConfig(
  vitestConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/coverage/**'],
      environment: 'node',
      pool: 'forks',
      poolOptions: { forks: { singleFork: false } },
      testTimeout: 20_000,
    },
    resolve: {
      // Resolve workspace packages via their src/ entrypoints so the
      // conformance test does not require a prior `pnpm build`.
      conditions: ['prosa-dev'],
    },
  }),
)
