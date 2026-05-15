import { configBase } from '@c3-oss/config-tsup'
import { type Options, defineConfig } from 'tsup'

const sharedBase = configBase as Options

export default defineConfig({
  ...sharedBase,
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  shims: false,
  banner: ({ format }) => {
    if (format !== 'esm') return {}
    return {
      js: "import { createRequire as __prosaCreateRequire } from 'module'; const require = __prosaCreateRequire(import.meta.url);",
    }
  },
  esbuildOptions(options) {
    options.conditions = ['node']
  },
  loader: {
    '.sql': 'text',
  },
})
