import type { Logger } from 'pino';

export type CompileLogger = Pick<Logger, 'child' | 'debug' | 'error' | 'info' | 'warn'>;

export interface CompileOptions {
  logger?: CompileLogger;
}
