import { z } from 'zod'

const objectStoreDriverSchema = z.enum(['s3', 'fs', 'memory'])
const runtimeModeSchema = z.enum(['production', 'development', 'test']).default('production')

const baseSchema = z.object({
  PROSA_API_URL: z.string().url().default('http://127.0.0.1:3000'),
  PROSA_API_HOST: z.string().default('127.0.0.1'),
  PROSA_API_PORT: z.coerce.number().int().positive().default(3000),
  PROSA_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  PROSA_RUNTIME_MODE: runtimeModeSchema,
  PROSA_DATABASE_URL: z.string().min(1).optional(),
  PROSA_AUTH_SECRET: z.string().min(16).optional(),
  /**
   * Comma-separated list of additional origins (in addition to PROSA_API_URL)
   * that browser apps may use to issue credentialed requests. Each entry must
   * be a full origin like `https://console.prosa.dev`.
   */
  PROSA_WEB_ORIGIN: z.string().optional(),
  PROSA_OBJECT_STORE_DRIVER: objectStoreDriverSchema.default('memory'),
  PROSA_OBJECT_STORE_BUCKET: z.string().optional(),
  PROSA_OBJECT_STORE_PREFIX: z.string().default('prosa/'),
  PROSA_OBJECT_STORE_ROOT: z.string().optional(),
  PROSA_OBJECT_STORE_ENDPOINT: z.string().url().optional(),
  PROSA_OBJECT_STORE_REGION: z.string().optional(),
  PROSA_OBJECT_STORE_ACCESS_KEY_ID: z.string().optional(),
  PROSA_OBJECT_STORE_SECRET_ACCESS_KEY: z.string().optional(),
})

export type RuntimeMode = 'production' | 'development' | 'test'

export type ProsaApiConfig = {
  apiUrl: string
  host: string
  port: number
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'
  runtimeMode: RuntimeMode
  databaseUrl: string | null
  authSecret: string | null
  /** Additional trusted browser origins (beyond `apiUrl`) for CORS and Better Auth. */
  webOrigins: string[]
  objectStore:
    | {
        driver: 's3'
        bucket: string
        prefix: string
        endpoint?: string
        region?: string
        accessKeyId?: string
        secretAccessKey?: string
      }
    | { driver: 'fs'; root: string; prefix: string }
    | { driver: 'memory'; prefix: string }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProsaApiConfig {
  const parsed = baseSchema.safeParse(env)
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${parsed.error.message}`)
  }
  const v = parsed.data

  // Fail-fast in production: no static fallback secret, real Postgres, and
  // an S3 (or fs) object store. The `memory` driver is rejected outside test.
  if (v.PROSA_RUNTIME_MODE === 'production') {
    if (!v.PROSA_AUTH_SECRET) {
      throw new ConfigError(
        'PROSA_AUTH_SECRET is required in production (>=16 chars). Refusing to start with a static fallback secret.',
      )
    }
    if (!v.PROSA_DATABASE_URL) {
      throw new ConfigError('PROSA_DATABASE_URL is required in production.')
    }
    if (v.PROSA_OBJECT_STORE_DRIVER === 'memory') {
      throw new ConfigError(
        'PROSA_OBJECT_STORE_DRIVER=memory is only allowed in test runs. Set driver to s3 or fs in production.',
      )
    }
  }
  if (v.PROSA_RUNTIME_MODE === 'development' && v.PROSA_OBJECT_STORE_DRIVER === 'memory') {
    // dev mode is allowed to use memory, but warn loudly via stderr
    process.stderr.write(
      'prosa-api: WARNING — using memory object store in development mode. Data will not persist across restarts.\n',
    )
  }

  const objectStore = ((): ProsaApiConfig['objectStore'] => {
    switch (v.PROSA_OBJECT_STORE_DRIVER) {
      case 's3': {
        if (!v.PROSA_OBJECT_STORE_BUCKET) {
          throw new ConfigError('PROSA_OBJECT_STORE_BUCKET is required when driver=s3')
        }
        const result: ProsaApiConfig['objectStore'] = {
          driver: 's3',
          bucket: v.PROSA_OBJECT_STORE_BUCKET,
          prefix: v.PROSA_OBJECT_STORE_PREFIX,
        }
        if (v.PROSA_OBJECT_STORE_ENDPOINT) result.endpoint = v.PROSA_OBJECT_STORE_ENDPOINT
        if (v.PROSA_OBJECT_STORE_REGION) result.region = v.PROSA_OBJECT_STORE_REGION
        if (v.PROSA_OBJECT_STORE_ACCESS_KEY_ID) result.accessKeyId = v.PROSA_OBJECT_STORE_ACCESS_KEY_ID
        if (v.PROSA_OBJECT_STORE_SECRET_ACCESS_KEY) result.secretAccessKey = v.PROSA_OBJECT_STORE_SECRET_ACCESS_KEY
        return result
      }
      case 'fs': {
        if (!v.PROSA_OBJECT_STORE_ROOT) {
          throw new ConfigError('PROSA_OBJECT_STORE_ROOT is required when driver=fs')
        }
        return { driver: 'fs', root: v.PROSA_OBJECT_STORE_ROOT, prefix: v.PROSA_OBJECT_STORE_PREFIX }
      }
      case 'memory':
        return { driver: 'memory', prefix: v.PROSA_OBJECT_STORE_PREFIX }
    }
  })()

  const webOrigins = (v.PROSA_WEB_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  for (const origin of webOrigins) {
    try {
      // Confirm each entry is a valid origin (URL parses, no path).
      const parsed = new URL(origin)
      if (parsed.pathname !== '/' && parsed.pathname !== '') {
        throw new Error('contains a path')
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid URL'
      throw new ConfigError(`PROSA_WEB_ORIGIN entry "${origin}" is not a valid origin: ${reason}`)
    }
  }

  return {
    apiUrl: v.PROSA_API_URL,
    host: v.PROSA_API_HOST,
    port: v.PROSA_API_PORT,
    logLevel: v.PROSA_LOG_LEVEL,
    runtimeMode: v.PROSA_RUNTIME_MODE,
    databaseUrl: v.PROSA_DATABASE_URL ?? null,
    authSecret: v.PROSA_AUTH_SECRET ?? null,
    webOrigins,
    objectStore,
  }
}
