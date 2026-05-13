#!/usr/bin/env node
import { runCli } from '../cli/main.js'

// Thin bin shim for package managers that invoke `src/bin/prosa.ts` directly.
runCli(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exit(1)
})
