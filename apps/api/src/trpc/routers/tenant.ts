import { z } from 'zod'
import { TRPCError, adminTenantProcedure, protectedProcedure, router } from '../init.js'

function fastifyHeadersWithAuth(ctx: { req: { headers: Record<string, unknown> } }): Headers {
  const h = new Headers()
  for (const [key, value] of Object.entries(ctx.req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) h.append(key, String(v))
    } else {
      h.set(key, String(value))
    }
  }
  return h
}

export const tenantRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const result = (await ctx.auth.api.listOrganizations({
      headers: fastifyHeadersWithAuth(ctx),
    })) as Array<{ id: string; name: string; slug?: string | null }>
    return result.map((org) => ({ id: org.id, name: org.name, slug: org.slug ?? null }))
  }),

  setActive: protectedProcedure.input(z.object({ tenantId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    await ctx.auth.api.setActiveOrganization({
      body: { organizationId: input.tenantId },
      headers: fastifyHeadersWithAuth(ctx),
    })
    return { tenantId: input.tenantId }
  }),

  invite: adminTenantProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: z.enum(['admin', 'member']).default('member'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = (await ctx.auth.api.createInvitation({
        body: { email: input.email, role: input.role, organizationId: ctx.tenantId },
        headers: fastifyHeadersWithAuth(ctx),
      })) as { id: string; email: string; role: string; status: string } | null
      if (!result) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Invite creation returned empty result' })
      }
      return result
    }),
})
