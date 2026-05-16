import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { schema as prosaSchema } from '@c3-oss/prosa-db'
import { betterAuth } from 'better-auth'
import { bearer, deviceAuthorization, organization } from 'better-auth/plugins'
import { ConfigError, type ProsaApiConfig, equivalentLoopbackOrigins, isLocalDevOrigin } from './config.js'
import type { ProsaDatabase } from './db.js'

const authSchema = {
  user: prosaSchema.user,
  session: prosaSchema.session,
  account: prosaSchema.account,
  verification: prosaSchema.verification,
  organization: prosaSchema.organization,
  member: prosaSchema.member,
  invitation: prosaSchema.invitation,
  jwks: prosaSchema.jwks,
  deviceCode: prosaSchema.deviceCode,
}

/**
 * Better Auth's plugin combinatorial types reference zod v4 internals which
 * TypeScript cannot port cleanly across package boundaries. We expose a
 * structural type that lists the procedures the API actually invokes; this
 * keeps consumers (`apps/cli` integration tests, the Fastify catchall, the
 * tRPC context, sync/auth/tenant routers) decoupled from those internals.
 */
// biome-ignore lint/suspicious/noExplicitAny: see comment above — pragmatic boundary
type BetterAuthApiCall<R = any> = (...args: any[]) => Promise<R>

export type ProsaAuth = {
  handler: (request: Request) => Promise<Response>
  api: {
    getSession: BetterAuthApiCall
    signUpEmail: BetterAuthApiCall
    signInEmail: BetterAuthApiCall
    signOut: BetterAuthApiCall
    createOrganization: BetterAuthApiCall
    setActiveOrganization: BetterAuthApiCall
    listOrganizations: BetterAuthApiCall
    createInvitation: BetterAuthApiCall
    deviceCode: BetterAuthApiCall
    deviceToken: BetterAuthApiCall
    deviceVerify: BetterAuthApiCall
    [key: string]: BetterAuthApiCall | undefined
  }
}

export type CreateAuthOptions = {
  config: ProsaApiConfig
  db: ProsaDatabase
}

/**
 * Resolve the Better Auth secret. Test runs are allowed to use a stable
 * development-only secret so we can deterministically generate session
 * tokens; production startup must supply a real `PROSA_AUTH_SECRET` (>=16
 * chars) via env or the API refuses to boot.
 */
function resolveAuthSecret(config: ProsaApiConfig): string {
  if (config.authSecret) return config.authSecret
  if (config.runtimeMode === 'production') {
    throw new ConfigError('PROSA_AUTH_SECRET is required in production. Refusing to use a static fallback secret.')
  }
  return 'development-only-secret-do-not-use-in-production'
}

export function createAuth(opts: CreateAuthOptions): ProsaAuth {
  const { config, db } = opts
  const secret = resolveAuthSecret(config)
  const baseTrustedOrigins = Array.from(
    new Set([config.apiUrl, ...config.webOrigins, ...equivalentLoopbackOrigins(config.apiUrl, config.runtimeMode)]),
  )
  const instance = betterAuth({
    appName: 'prosa',
    baseURL: config.apiUrl,
    basePath: '/api/auth',
    secret,
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // seconds — 5 min window where session is read from cookie without hitting DB
      },
    },
    trustedOrigins: async (request?: Request) => {
      const origins = new Set(baseTrustedOrigins)
      const origin = request?.headers.get('origin')
      if (origin && isLocalDevOrigin(origin, config.runtimeMode)) {
        origins.add(origin)
      }
      return Array.from(origins)
    },
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: false,
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/*': { window: 60, max: 10 },
        '/sign-up/*': { window: 60, max: 10 },
        '/device/code': { window: 60, max: 20 },
        '/device/token': { window: 60, max: 30 },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 32,
        creatorRole: 'admin',
        membershipLimit: 256,
        invitationExpiresIn: 60 * 60 * 24 * 7,
      }),
      deviceAuthorization({
        // Plugin uses model name `deviceCode` by default, with field names
        // matching the camelCase JS property names of our Drizzle schema.
        // Pass an empty schema override so the option's `schema` Zod field
        // (typed as nonoptional) is satisfied.
        schema: {} as never,
      } as never),
      bearer(),
    ],
  })
  return instance as unknown as ProsaAuth
}
