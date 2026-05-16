import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import fastifyCors from '@fastify/cors'
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

  // Credentialed CORS for browser-origin reads. The API URL is always
  // allowed; additional browser origins come from `PROSA_WEB_ORIGIN`. We
  // never allow `*` because credentials must be sent.
  const allowedOrigins = new Set<string>([opts.config.apiUrl, ...opts.config.webOrigins])
  await app.register(fastifyCors, {
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-prosa-tenant-id', 'x-prosa-device-id'],
    origin: (origin, cb) => {
      // Same-origin / non-browser callers (curl, server-to-server) send no Origin
      // header; allow them to reach the API.
      if (!origin) return cb(null, true)
      if (allowedOrigins.has(origin)) return cb(null, true)
      return cb(null, false)
    },
  })

  // fastify-cors registers a catch-all `OPTIONS *` handler, but @trpc/server's
  // Fastify adapter uses `fastify.all('/trpc/:path')`, so OPTIONS preflights to
  // tRPC routes hit the tRPC handler (which then 415s on missing content-type)
  // before fastify-cors gets to short-circuit them. CORS response headers were
  // already added in fastify-cors' onRequest hook above, so we just terminate
  // the request here with 204 for any browser-style preflight.
  app.addHook('onRequest', async (req, reply) => {
    if (
      req.method === 'OPTIONS' &&
      typeof req.headers.origin === 'string' &&
      typeof req.headers['access-control-request-method'] === 'string'
    ) {
      reply.code(204).send()
    }
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

      // CQ-007: strip bearer tokens from Better Auth responses for ANY
      // caller that sends a non-empty Origin header. Browsers always
      // attach an Origin (including same-origin when the API and SPA share
      // a host); CLI / device callers never attach one. Even when the
      // Origin equals the API URL (same-origin browser deploy), the
      // response must omit the token so the bearer never reaches
      // JavaScript. The session cookie set above is the only credential
      // the browser needs.
      const originHeader = request.headers.origin
      const requestOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader
      const isBrowserOrigin = typeof requestOrigin === 'string' && requestOrigin.length > 0
      if (isBrowserOrigin && responseBody.length > 0) {
        try {
          const parsed = JSON.parse(responseBody) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // CQ-011: strip every bearer-token-bearing field — `token`,
            // `access_token`, `refresh_token`, `id_token`. Covers the raw
            // `/api/auth/device/token` path as well as sign-up / sign-in.
            const sanitized = stripBearerTokenFields(parsed as Record<string, unknown>)
            const serialized = JSON.stringify(sanitized)
            reply.header('content-length', Buffer.byteLength(serialized).toString())
            return reply.send(serialized)
          }
        } catch {
          // Body is not JSON (HTML / text) — pass through unchanged.
        }
      }

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

const BEARER_TOKEN_KEYS = new Set([
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'id_token',
  'idToken',
])

/**
 * Recursively remove every bearer-token-bearing field from a JSON object.
 * Covers the catch-all `/api/auth/*` responses (sign-up / sign-in / device
 * token) so a browser-origin caller never sees a bearer token in JSON.
 */
function stripBearerTokenFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (BEARER_TOKEN_KEYS.has(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = stripBearerTokenFields(value as Record<string, unknown>)
    } else {
      out[key] = value
    }
  }
  return out
}
