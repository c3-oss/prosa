import { createHash } from 'node:crypto'
import { TRPCError, initTRPC } from '@trpc/server'
import type { ProsaApiContext } from './context.js'

type RateLimitEntry = {
  count: number
  resetAt: number
}

export type RateLimitKeyResolver = (opts: {
  ctx: ProsaApiContext
  path: string
  input: unknown
}) => string | null

type RateLimitOptions = {
  bucket: string
  windowMs: number
  max: number
  key?: RateLimitKeyResolver
}

const rateLimitBuckets = new Map<string, RateLimitEntry>()
let lastRateLimitSweep = 0

function sweepExpiredRateLimits(now: number): void {
  if (now - lastRateLimitSweep < 60_000) return
  lastRateLimitSweep = now
  for (const [key, entry] of rateLimitBuckets.entries()) {
    if (entry.resetAt <= now) rateLimitBuckets.delete(key)
  }
}

const t = initTRPC.context<ProsaApiContext>().create({
  errorFormatter({ shape }) {
    return shape
  },
})

export const router = t.router
export const middleware = t.middleware
export const publicProcedure = t.procedure

export function resetRateLimitBucketsForTests(): void {
  rateLimitBuckets.clear()
  lastRateLimitSweep = 0
}

function createRateLimitMiddleware(opts: RateLimitOptions) {
  return t.middleware(async ({ ctx, path, input, next }) => {
    const now = Date.now()
    sweepExpiredRateLimits(now)
    const keySuffix = opts.key?.({ ctx, path, input }) ?? clientIpRateLimitKey(ctx)
    const key = `${opts.bucket}:${keySuffix}`
    const entry = rateLimitBuckets.get(key)
    if (!entry || entry.resetAt <= now) {
      rateLimitBuckets.set(key, { count: 1, resetAt: now + opts.windowMs })
      return next()
    }
    if (entry.count >= opts.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
      })
    }
    entry.count += 1
    return next()
  })
}

export function clientIpRateLimitKey(ctx: Pick<ProsaApiContext, 'clientIp'>): string {
  return ctx.clientIp ?? 'unknown'
}

export function hashRateLimitValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function rateLimitedProcedure(opts: RateLimitOptions) {
  return createRateLimitMiddleware(opts)
}

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
