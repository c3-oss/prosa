import { z } from 'zod'
import { TRPCError, protectedProcedure, publicProcedure, router } from '../init.js'

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

export const authRouter = router({
  me: protectedProcedure.query(({ ctx }) => ({
    user: ctx.user,
    session: ctx.session,
    tenantId: ctx.tenantId,
    memberRole: ctx.memberRole,
  })),

  signupWithTenant: publicProcedure.input(signupInput).mutation(async ({ ctx, input }) => {
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

    const authHeaders = new Headers(responseHeaders)
    authHeaders.set('authorization', `Bearer ${sessionToken}`)

    const slug =
      input.tenantSlug ??
      input.tenantName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .slice(0, 32)
    const created = (await ctx.auth.api.createOrganization({
      body: { name: input.tenantName, slug },
      headers: authHeaders,
    })) as { id: string; slug?: string | null; name: string } | null

    if (!created) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Tenant creation returned empty result',
      })
    }

    await ctx.auth.api.setActiveOrganization({
      body: { organizationId: created.id },
      headers: authHeaders,
    })

    return {
      token: sessionToken,
      user,
      tenant: { id: created.id, name: created.name, slug: created.slug ?? null },
    }
  }),
})
