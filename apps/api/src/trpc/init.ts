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
  if (!ctx.tenantId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Active tenant required. Pass `tenantId` or set X-Prosa-Tenant-Id.',
    })
  }
  return next({ ctx: { ...ctx, tenantId: ctx.tenantId } })
})

export const tenantProcedure = t.procedure.use(requireTenant)

const requireAdmin = requireTenant.unstable_pipe(({ ctx, next }) => {
  if (!ctx.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin role required' })
  }
  return next({ ctx })
})

export const adminTenantProcedure = t.procedure.use(requireAdmin)

export { TRPCError }
