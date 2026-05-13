import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'

export interface CliLoggerOptions {
  verbose?: boolean
  jsonLogs?: boolean
}

export function createCliLogger(options: CliLoggerOptions): Logger {
  const loggerOptions = {
    base: undefined,
    level: options.verbose ? 'debug' : 'info',
  }

  if (options.jsonLogs) {
    return pino(loggerOptions, pino.destination({ dest: 2, sync: true }))
  }

  return pino(
    loggerOptions,
    pretty({
      colorize: process.stderr.isTTY,
      destination: 2,
      ignore: 'pid,hostname',
      singleLine: false,
      sync: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    }),
  )
}
