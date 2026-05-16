import { z } from 'zod'
import type { RawExec } from '../../db.js'
import { headersFromTrpcCtx } from '../../shared/http.js'
import {
  TRPCError,
  adminTenantProcedure,
  clientIpRateLimitKey,
  hashRateLimitValue,
  protectedProcedure,
  publicProcedure,
  rateLimitedProcedure,
  router,
} from '../init.js'
import type { RateLimitKeyResolver } from '../init.js'

const AUTH_RATE_LIMIT_WINDOW_MS = 60_000

const signupInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  name: z.string().min(1).max(120),
  tenantName: z.string().min(1).max(120),
  tenantSlug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
})

const deviceTokenInput = z.object({
  deviceCode: z.string().min(1),
  clientId: z.string().min(1).default('prosa-cli'),
})

function authRateLimit(
  bucket: string,
  max: number,
  key: RateLimitKeyResolver = ({ ctx }) => clientIpRateLimitKey(ctx),
) {
  return rateLimitedProcedure({
    bucket: `auth.${bucket}`,
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    max,
    key,
  })
}

function deviceTokenRateLimitKey({
  ctx,
  input,
}: {
  ctx: { clientIp: string | null }
  input: unknown
}): string {
  const deviceCode =
    input && typeof input === 'object' && 'deviceCode' in input && typeof input.deviceCode === 'string'
      ? input.deviceCode
      : 'unknown'
  return `${clientIpRateLimitKey(ctx)}:${hashRateLimitValue(deviceCode)}`
}

function tenantUserRateLimitKey(ctx: {
  tenantId: string | null
  user: { id: string } | null
  clientIp: string | null
}): string {
  return `${ctx.tenantId ?? 'no-tenant'}:${ctx.user?.id ?? clientIpRateLimitKey(ctx)}`
}

type MemberOrgRow = {
  organization_id: string
  organization_name: string
  organization_slug: string | null
  role: string
}

type SignupContext = {
  rawExec: RawExec
  req: { log?: { error?: (data: unknown, msg?: string) => void } }
}

type Tenant = { id: string; slug?: string | null; name: string }

function asTrpcError(err: unknown, fallback: string, code: 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR'): TRPCError {
  if (err instanceof TRPCError) return err
  const message = err instanceof Error && err.message ? `${fallback}: ${err.message}` : fallback
  return new TRPCError({ code, message })
}

function deriveTenantSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 32)
}

/** Rollback the half-created auth rows for a user. Best-effort; never throws. */
async function rollbackOrphanUser(ctx: SignupContext, userId: string): Promise<void> {
  try {
    // Dependency order: members (cascades on user/org), then session, account, user.
    await ctx.rawExec('DELETE FROM "member" WHERE user_id = $1', [userId])
    await ctx.rawExec('DELETE FROM "session" WHERE user_id = $1', [userId])
    await ctx.rawExec('DELETE FROM "account" WHERE user_id = $1', [userId])
    await ctx.rawExec('DELETE FROM "user" WHERE id = $1', [userId])
  } catch (rollbackErr) {
    ctx.req.log?.error?.({ err: rollbackErr, userId }, 'signup rollback failed')
  }
}

async function deleteHalfCreatedOrg(ctx: SignupContext, orgId: string): Promise<void> {
  try {
    await ctx.rawExec('DELETE FROM "organization" WHERE id = $1', [orgId])
  } catch (cleanupErr) {
    ctx.req.log?.error?.({ err: cleanupErr, orgId }, 'org cleanup failed')
  }
}

export const authRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    // Resolve every tenant this user is a member of, joined with role. We
    // never trust the client to declare its tenants — the source of truth
    // is the `member` table joined to `organization`.
    const tenants = await ctx.rawExec<MemberOrgRow>(
      `SELECT m.organization_id, o.name AS organization_name, o.slug AS organization_slug, m.role
         FROM "member" m
         JOIN "organization" o ON o.id = m.organization_id
         WHERE m.user_id = $1
         ORDER BY o.name ASC, m.organization_id ASC`,
      [ctx.user.id],
    )
    return {
      user: ctx.user,
      session: ctx.session,
      tenantId: ctx.tenantId,
      memberRole: ctx.memberRole,
      tenants: tenants.map((row) => ({
        id: row.organization_id,
        name: row.organization_name,
        slug: row.organization_slug,
        role: row.role,
      })),
    }
  }),

  /**
   * Issue an OAuth Device Authorization code. The CLI calls this without
   * authentication and then polls `deviceToken` until the user approves
   * the request in a browser via `verificationUri`.
   */
  deviceCode: publicProcedure
    .input(z.object({ clientId: z.string().min(1).max(64).default('prosa-cli') }))
    .use(authRateLimit('deviceCode', 20))
    .mutation(async ({ ctx, input }) => {
      const result = (await ctx.auth.api.deviceCode({
        body: { client_id: input.clientId },
        headers: new Headers(),
      })) as {
        device_code: string
        user_code: string
        verification_uri: string
        verification_uri_complete?: string
        expires_in: number
        interval: number
      } | null
      if (!result) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Device code issue failed' })
      }
      return {
        deviceCode: result.device_code,
        userCode: result.user_code,
        verificationUri: `${ctx.config.apiUrl}${result.verification_uri.startsWith('/') ? '' : '/'}${result.verification_uri}`,
        verificationUriComplete: result.verification_uri_complete ?? null,
        expiresIn: result.expires_in,
        interval: result.interval,
      }
    }),

  /**
   * Poll for an issued session token. Returns `{ pending: true }` until the
   * user approves; returns `{ token, user }` on success. The CLI uses this
   * to complete the device-flow login without prompting for a password.
   */
  deviceToken: publicProcedure
    .input(deviceTokenInput)
    .use(authRateLimit('deviceToken', 10, deviceTokenRateLimitKey))
    .mutation(async ({ ctx, input }) => {
      // CQ-011: the device-token flow issues a CLI bearer. Browsers must
      // never receive that bearer in JSON. Any request that carries a
      // non-empty `Origin` header is treated as a browser caller and is
      // rejected before Better Auth ever issues a token. CLI / device
      // callers omit `Origin` and continue to receive the token after
      // device approval.
      const originHeader = ctx.req.headers.origin
      const requestOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader
      if (typeof requestOrigin === 'string' && requestOrigin.length > 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Device-token flow is CLI/device-only; browser callers cannot obtain bearer tokens.',
        })
      }
      try {
        const result = (await ctx.auth.api.deviceToken({
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: input.deviceCode,
            client_id: input.clientId,
          },
          headers: new Headers(),
          asResponse: true,
        })) as unknown
        if (!result) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'deviceToken returned empty' })
        }
        // When asResponse:true Better Auth returns a fetch Response. The
        // structured body lives under .body once parsed.
        type DeviceTokenBody = { access_token?: string; user?: unknown; error?: string }
        let raw: string | null = null
        if (result instanceof Response) {
          raw = await result.text()
        } else if (result && typeof result === 'object') {
          raw = JSON.stringify(result)
        }
        if (!raw) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'deviceToken empty body' })
        }
        const body = JSON.parse(raw) as DeviceTokenBody
        if (body.error) {
          const errCode = body.error
          if (errCode === 'authorization_pending' || errCode === 'slow_down') {
            return { pending: true as const, code: errCode }
          }
          throw new TRPCError({ code: 'BAD_REQUEST', message: `device-flow: ${errCode}` })
        }
        if (!body.access_token) {
          return { pending: true as const, code: 'authorization_pending' as const }
        }
        return {
          pending: false as const,
          token: body.access_token,
          user: (body.user as { id: string; email: string; name: string } | null) ?? null,
        }
      } catch (err: unknown) {
        // Better Auth raises a thrown APIError for `authorization_pending` /
        // `slow_down` / `access_denied` / `expired_token`. We translate the
        // first two into a pending response so the CLI can keep polling and
        // surface the rest as user-visible CLI errors.
        const errBody = (err as { body?: { error?: string } } | null)?.body
        const errCode = errBody?.error ?? null
        if (errCode === 'authorization_pending' || errCode === 'slow_down') {
          return { pending: true as const, code: errCode }
        }
        if (errCode) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `device-flow: ${errCode}` })
        }
        const message = err instanceof Error ? err.message : String(err)
        if (/authorization_pending|slow_down/i.test(message)) {
          return { pending: true as const, code: 'authorization_pending' as const }
        }
        throw err
      }
    }),

  /** Tenant invite proxy kept on auth.* for backwards compatibility. */
  inviteMember: adminTenantProcedure
    .input(z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).default('member') }))
    .use(authRateLimit('inviteMember', 20, ({ ctx }) => tenantUserRateLimitKey(ctx)))
    .mutation(async ({ ctx, input }) => {
      const created = (await ctx.auth.api.createInvitation({
        body: { email: input.email, role: input.role, organizationId: ctx.tenantId },
        headers: headersFromTrpcCtx(ctx),
      })) as { id: string; email: string; role: string; status: string } | null
      if (!created) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'invite failed' })
      }
      return created
    }),

  signupWithTenant: publicProcedure
    .input(signupInput)
    .use(authRateLimit('signupWithTenant', 40))
    .mutation(async ({ ctx, input }) => {
      const signupResult = (await ctx.auth.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name },
        headers: new Headers(),
        returnHeaders: true,
      })) as
        | { headers: Headers; response: { token?: string; user?: { id: string; email: string; name: string } } }
        | { token?: string; user?: { id: string; email: string; name: string } }

      const response = 'response' in signupResult ? signupResult.response : signupResult
      const responseHeaders = 'headers' in signupResult ? signupResult.headers : new Headers()
      const sessionToken = response.token
      const user = response.user
      if (!user || !sessionToken) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Signup did not return a session' })
      }

      // From here on, the user exists but isn't useful without a tenant. Each
      // step rolls back the user (and any org it created) on failure.
      const authHeaders = new Headers(responseHeaders)
      authHeaders.set('authorization', `Bearer ${sessionToken}`)
      const slug = input.tenantSlug ?? deriveTenantSlug(input.tenantName)

      let created: Tenant | null
      try {
        created = (await ctx.auth.api.createOrganization({
          body: { name: input.tenantName, slug },
          headers: authHeaders,
        })) as Tenant | null
      } catch (err) {
        await rollbackOrphanUser(ctx, user.id)
        throw asTrpcError(err, 'Tenant creation failed', 'BAD_REQUEST')
      }

      if (!created) {
        await rollbackOrphanUser(ctx, user.id)
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Tenant creation returned empty result' })
      }

      try {
        await ctx.auth.api.setActiveOrganization({
          body: { organizationId: created.id },
          headers: authHeaders,
        })
      } catch (err) {
        await deleteHalfCreatedOrg(ctx, created.id)
        await rollbackOrphanUser(ctx, user.id)
        throw asTrpcError(err, 'Setting active tenant failed', 'INTERNAL_SERVER_ERROR')
      }

      // CQ-007: any caller that sends a non-empty Origin header is treated
      // as a browser caller and must NOT receive a bearer token in the
      // response body. Browsers always attach Origin (including same-origin
      // deploys where Origin equals the API URL); CLI / device flows never
      // attach one. Better Auth's HTTP-only cookie is the only credential
      // the browser needs.
      const originHeader = ctx.req.headers.origin
      const requestOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader
      const isBrowserOrigin = typeof requestOrigin === 'string' && requestOrigin.length > 0

      // Forward Better Auth's Set-Cookie so the browser receives the
      // session cookie inline with the signup response.
      const setCookieHeader = responseHeaders.get('set-cookie')
      if (setCookieHeader) {
        const reply = ctx.res
        // Fastify uses .header / .setHeader depending on plugin layout.
        if (typeof (reply as { header?: (name: string, value: string) => void }).header === 'function') {
          ;(reply as { header: (name: string, value: string) => void }).header('set-cookie', setCookieHeader)
        }
      }

      return {
        ...(isBrowserOrigin ? {} : { token: sessionToken }),
        user,
        tenant: { id: created.id, name: created.name, slug: created.slug ?? null },
      }
    }),
})
