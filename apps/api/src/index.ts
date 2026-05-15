export { buildApp, type BuildAppOptions } from './app.js'
export { loadConfig, ConfigError, type ProsaApiConfig } from './config.js'
export { createAuth, type ProsaAuth, type CreateAuthOptions } from './auth.js'
export {
  openPostgresDatabase,
  openPgliteDatabase,
  type DatabaseHandle,
  type ProsaDatabase,
  type RawExec,
} from './db.js'
export { createObjectStore } from './storage.js'
export { appRouter, type AppRouter } from './trpc/router.js'
export type { ProsaApiContext } from './trpc/context.js'
export { readPackageVersion } from './version.js'
