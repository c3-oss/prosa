import { TRPCError, initTRPC } from '@trpc/server'
import type { ProsaApiContext } from './context.js'

const t = initTRPC.context<ProsaApiContext>().create({
  errorFormatter({ shape }) {
    return shape
  },
})

export const router = t.router
export const middleware = t.middleware
export const publicProcedure = t.procedure

const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' })
  }
  return next({ ctx: { ...ctx, user: ctx.user, session: ctx.session } })
})

export const protectedProcedure = t.procedure.use(requireUser)

const requireTenant = requireUser.unstable_pipe(({ ctx, next }) => {
  if (!ctx.tenantId || !ctx.memberRole) {
    // tenantId is only set on the context after a real membership lookup,
    // so a null value here means: caller is not a member of any tenant they
    // tried to address (header or session activeOrganization).
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Active tenant required. The current user is not a member of the requested tenant.',
    })
  }
  return next({ ctx: { ...ctx, tenantId: ctx.tenantId, memberRole: ctx.memberRole } })
})

export const tenantProcedure = t.procedure.use(requireTenant)

const requireAdmin = requireTenant.unstable_pipe(({ ctx, next }) => {
  if (ctx.memberRole !== 'admin' && ctx.memberRole !== 'owner') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin role required for this operation.',
    })
  }
  return next({ ctx })
})

export const adminTenantProcedure = t.procedure.use(requireAdmin)

export { TRPCError }
