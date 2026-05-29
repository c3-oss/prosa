import { configBase } from '@c3-oss/config-tsup'
import { type Options, defineConfig } from 'tsup'

const sharedBase = configBase as Options

export default defineConfig({
  ...sharedBase,
  entry: {
    index: 'src/index.ts',
    'bin/prosa': 'src/bin/prosa.ts',
    'cli/main': 'src/cli/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  shims: false,
  // Bundle internal workspace packages that are kept `"private": true` in
  // the monorepo (no separate npm publish). `@c3-oss/prosa-core` is published
  // independently and stays external.
  noExternal: [
    '@c3-oss/prosa-bundle-v2',
    '@c3-oss/prosa-derived-v2',
    '@c3-oss/prosa-importers-v2',
    '@c3-oss/prosa-types-v2',
    '@c3-oss/prosa-wire-v2',
  ],
  // Keep transitive runtime deps of the bundled v2 packages external so
  // tsup doesn't try to bundle native bindings (DuckDB, Tantivy,
  // better-sqlite3, zstd-napi). These get resolved at install time via the
  // CLI's own runtime deps and `@c3-oss/prosa-core`, which already declares
  // every native binding the v2 packages need.
  external: [
    '@duckdb/node-api',
    '@oxdev03/node-tantivy-binding',
    'better-sqlite3',
    'zstd-napi',
    '@noble/hashes',
    'zod',
  ],
})
