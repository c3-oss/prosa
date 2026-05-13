import { configBase } from '@c3-oss/config-tsup'
import { type Options, defineConfig } from 'tsup'

// `configBase` is typed as Options | Options[] | factory because tsup allows
// all three. The shared package returns a single Options object, so spread
// it as such — `dts`, `clean`, and `silent` flow in from the base; everything
// below is prosa-specific (multi-entry CLI bundle with an ESM `require` shim).
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
