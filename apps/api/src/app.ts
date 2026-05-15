import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { type FastifyTRPCPluginOptions, fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify, { type FastifyInstance } from 'fastify'
import type { ProsaAuth } from './auth.js'
import type { ProsaApiConfig } from './config.js'
import type { DatabaseHandle, ProsaDatabase, RawExec } from './db.js'
import { registerObjectRoutes } from './http/objects.js'
import { buildCreateContext } from './trpc/context.js'
import { type AppRouter, appRouter } from './trpc/router.js'
import { readPackageVersion } from './version.js'

export type BuildAppOptions = {
  config: ProsaApiConfig
  auth: ProsaAuth
  db: ProsaDatabase
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  loggerEnabled?: boolean
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.loggerEnabled === false ? false : { level: opts.config.logLevel },
    genReqId: () => crypto.randomUUID(),
  })

  app.get('/health', async () => ({ ok: true as const, version: readPackageVersion() }))

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, opts.config.apiUrl)
      const headers = new Headers()
      for (const [key, value] of Object.entries(request.headers)) {
        if (value == null) continue
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, String(v))
        } else {
          headers.set(key, String(value))
        }
      }
      const body =
        request.method === 'GET' || request.body == null
          ? undefined
          : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body)
      if (body && !headers.has('content-type')) headers.set('content-type', 'application/json')
      const response = await opts.auth.handler(
        new Request(url.toString(), {
          method: request.method,
          headers,
          body,
        }),
      )
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === 'set-cookie') {
          reply.header('set-cookie', value)
        } else {
          reply.header(key, value)
        }
      })
      reply.status(response.status)
      const responseBody = response.body ? await response.text() : ''
      return reply.send(responseBody)
    },
  })

  await registerObjectRoutes(app, {
    auth: opts.auth,
    rawExec: opts.rawExec,
    objectStore: opts.objectStore,
  })

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: buildCreateContext({
        config: opts.config,
        auth: opts.auth,
        db: opts.db,
        rawExec: opts.rawExec,
        transaction: opts.transaction,
        objectStore: opts.objectStore,
      }),
      onError({ error, path, ctx }) {
        const requestId = ctx?.requestId ?? null
        app.log.error({ err: error, path, requestId }, 'trpc procedure failed')
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  })

  return app
}
