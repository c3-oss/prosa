import type { Logger } from 'pino'

/** Minimal structured logger surface used by importers while compiling source files. */
export type CompileLogger = Pick<Logger, 'child' | 'debug' | 'error' | 'info' | 'warn'>

/** Shared options accepted by every importer compile entrypoint. */
export interface CompileOptions {
  /** Optional logger for batch, file discovery, skip, and per-file failure events. */
  logger?: CompileLogger
}
