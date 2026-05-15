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
})
