import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { schema as prosaSchema } from '@c3-oss/prosa-db'
import { betterAuth } from 'better-auth'
import { bearer, organization } from 'better-auth/plugins'
import type { ProsaApiConfig } from './config.js'
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
}

export type ProsaAuth = ReturnType<typeof createAuth>

export type CreateAuthOptions = {
  config: ProsaApiConfig
  db: ProsaDatabase
}

export function createAuth(opts: CreateAuthOptions) {
  const { config, db } = opts
  const secret = config.authSecret ?? 'development-only-secret-do-not-use-in-production'
  return betterAuth({
    appName: 'prosa',
    baseURL: config.apiUrl,
    basePath: '/api/auth',
    secret,
    trustedOrigins: [config.apiUrl],
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
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        organizationLimit: 32,
        creatorRole: 'admin',
        membershipLimit: 256,
        invitationExpiresIn: 60 * 60 * 24 * 7,
      }),
      bearer(),
    ],
  })
}
