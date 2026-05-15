import { z } from 'zod'
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

function requestHeadersFromContext(ctx: { req: { headers: Record<string, string | string[] | undefined> } }): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v))
    } else {
      headers.set(key, String(value))
    }
  }
  return headers
}

type MemberOrgRow = {
  organization_id: string
  organization_name: string
  organization_slug: string | null
  role: string
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
        headers: requestHeadersFromContext(ctx),
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

      // From this point on, any failure leaves the new user orphaned. Wrap the
      // post-user steps in a try/catch and roll back the user + session via raw
      // SQL on the auth tables.
      const rollback = async (): Promise<void> => {
        // Delete in dependency order: member rows (cascade on user/org), then
        // organization (created below — may not exist yet), then session, then
        // account, then user.
        try {
          await ctx.rawExec('DELETE FROM "member" WHERE user_id = $1', [user.id])
          await ctx.rawExec('DELETE FROM "session" WHERE user_id = $1', [user.id])
          await ctx.rawExec('DELETE FROM "account" WHERE user_id = $1', [user.id])
          await ctx.rawExec('DELETE FROM "user" WHERE id = $1', [user.id])
        } catch (rollbackErr) {
          // Surface in the API logs but don't mask the original error.
          ctx.req.log?.error?.({ err: rollbackErr, userId: user.id }, 'signup rollback failed')
        }
      }

      const authHeaders = new Headers(responseHeaders)
      authHeaders.set('authorization', `Bearer ${sessionToken}`)

      const slug =
        input.tenantSlug ??
        input.tenantName
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .slice(0, 32)

      let created: { id: string; slug?: string | null; name: string } | null
      try {
        created = (await ctx.auth.api.createOrganization({
          body: { name: input.tenantName, slug },
          headers: authHeaders,
        })) as { id: string; slug?: string | null; name: string } | null
      } catch (err) {
        await rollback()
        throw err instanceof TRPCError
          ? err
          : new TRPCError({
              code: 'BAD_REQUEST',
              message:
                err instanceof Error && err.message
                  ? `Tenant creation failed: ${err.message}`
                  : 'Tenant creation failed',
            })
      }

      if (!created) {
        await rollback()
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Tenant creation returned empty result',
        })
      }

      try {
        await ctx.auth.api.setActiveOrganization({
          body: { organizationId: created.id },
          headers: authHeaders,
        })
      } catch (err) {
        // Also delete the half-created organization so a retry with the same
        // slug is not blocked.
        try {
          await ctx.rawExec('DELETE FROM "organization" WHERE id = $1', [created.id])
        } catch (cleanupErr) {
          ctx.req.log?.error?.({ err: cleanupErr, orgId: created.id }, 'org cleanup failed')
        }
        await rollback()
        throw err instanceof TRPCError
          ? err
          : new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message:
                err instanceof Error && err.message
                  ? `Setting active tenant failed: ${err.message}`
                  : 'Setting active tenant failed',
            })
      }

      return {
        token: sessionToken,
        user,
        tenant: { id: created.id, name: created.name, slug: created.slug ?? null },
      }
    }),
})
