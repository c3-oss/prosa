import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/prosa': 'src/bin/prosa.ts',
    'cli/main': 'src/cli/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  clean: true,
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
