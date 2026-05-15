import { z } from 'zod'
import { readPackageVersion } from '../version.js'
import { publicProcedure, router } from './init.js'

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
})

export type AppRouter = typeof appRouter
