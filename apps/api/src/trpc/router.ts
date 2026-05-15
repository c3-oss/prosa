import { z } from 'zod'
import { readPackageVersion } from '../version.js'
import { publicProcedure, router } from './init.js'
import { authRouter } from './routers/auth.js'
import { analyticsRouter, artifactsRouter, searchRouter, sessionsRouter, toolCallsRouter } from './routers/reads.js'
import { syncRouter } from './routers/sync.js'
import { tenantRouter } from './routers/tenant.js'

const healthRouter = router({
  ping: publicProcedure.query(() => ({ ok: true as const, version: readPackageVersion() })),
})

const echoRouter = router({
  echo: publicProcedure
    .input(z.object({ message: z.string().max(1024) }))
    .query(({ input }) => ({ message: input.message })),
})

export const appRouter = router({
  health: healthRouter,
  system: echoRouter,
  auth: authRouter,
  tenant: tenantRouter,
  sync: syncRouter,
  sessions: sessionsRouter,
  search: searchRouter,
  toolCalls: toolCallsRouter,
  artifacts: artifactsRouter,
  analytics: analyticsRouter,
})

export type AppRouter = typeof appRouter
