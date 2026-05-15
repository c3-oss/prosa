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
export { TRPCError }
