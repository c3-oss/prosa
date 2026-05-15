import { configBase } from '@c3-oss/config-tsup'
import { type Options, defineConfig } from 'tsup'

const sharedBase = configBase as Options

export default defineConfig({
  ...sharedBase,
  entry: {
    index: 'src/index.ts',
    'schema/index': 'src/schema/index.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  shims: false,
})
