import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ProsaAuth } from '../auth.js'
import type { RawExec } from '../db.js'
import { resolveMembership } from '../trpc/context.js'

export type ObjectRoutesDeps = {
  auth: ProsaAuth
  rawExec: RawExec
  objectStore: RemoteObjectStore
}

function fastifyHeadersToHeaders(req: FastifyRequest): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v))
    } else {
      headers.set(key, String(value))
    }
  }
  return headers
}

async function resolveAuth(opts: ObjectRoutesDeps, req: FastifyRequest) {
  const headers = fastifyHeadersToHeaders(req)
  const result = (await opts.auth.api.getSession({ headers })) as {
    session: { id: string; userId: string; activeOrganizationId?: string | null }
    user: { id: string; email: string }
  } | null
  if (!result) return null
  // Tenant resolution must verify membership against the `member` table, just
  // like the tRPC context. Trusting `x-prosa-tenant-id` directly would let a
  // signed-in user spoof another tenant's objects.
  const candidate =
    (req.headers['x-prosa-tenant-id'] as string | undefined) ?? result.session.activeOrganizationId ?? null
  if (!candidate) {
    return { user: result.user, session: result.session, tenantId: null }
  }
  const role = await resolveMembership({
    rawExec: opts.rawExec,
    tenantId: candidate,
    userId: result.user.id,
  })
  if (!role) {
    return { user: result.user, session: result.session, tenantId: null }
  }
  return { user: result.user, session: result.session, tenantId: candidate }
}

export async function registerObjectRoutes(app: FastifyInstance, deps: ObjectRoutesDeps) {
  // Enable raw body parsing for octet-stream so PUT bodies pass through unmodified.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.route({
    method: 'PUT',
    url: '/objects/:objectId',
    config: { rawBody: true },
    handler: async (request, reply) => {
      const ctx = await resolveAuth(deps, request)
      if (!ctx) {
        reply.code(401)
        return { error: 'unauthorized' }
      }
      if (!ctx.tenantId) {
        reply.code(403)
        return { error: 'not a member of the requested tenant' }
      }
      const { objectId } = request.params as { objectId: string }
      if (!objectId || !/^[a-zA-Z0-9_-]{8,128}$/.test(objectId)) {
        reply.code(400)
        return { error: 'invalid objectId' }
      }
      // Look up declared object metadata from sync_batch object_meta (clients
      // declare metadata in `planUpload`; we then expect them to send bytes
      // matching that declaration). For now we read the metadata from query
      // params (`?hash=...&size=...&uncompressed=...`).
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
      const hash = url.searchParams.get('hash')
      const compressedSize = Number(url.searchParams.get('size') ?? '0')
      const uncompressedSize = Number(url.searchParams.get('uncompressed') ?? '0')
      if (!hash || !Number.isFinite(compressedSize) || compressedSize <= 0) {
        reply.code(400)
        return { error: 'hash and size query parameters required' }
      }

      const rawBody = request.body
      if (!Buffer.isBuffer(rawBody)) {
        reply.code(400)
        return { error: 'binary body required (use application/octet-stream)' }
      }
      const body: Buffer = rawBody
      if (body.byteLength !== compressedSize) {
        reply.code(400)
        return {
          error: `size mismatch: header declared ${compressedSize}, body has ${body.byteLength}`,
        }
      }

      const storageKey = `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`

      async function* once() {
        yield new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
      }

      const put = await deps.objectStore.putIfAbsent(storageKey, once(), {
        hash,
        hashAlgorithm: 'blake3',
        uncompressedSize,
        compressedSize,
      })

      // Best-effort metadata insert (no tenant binding here — that happens at
      // commitUpload). If the row already exists, leave it alone.
      await deps.rawExec(
        `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key)
         VALUES ($1, $2, 'blake3', 'zstd', $3, $4, $5)
         ON CONFLICT (object_id) DO NOTHING`,
        [objectId, hash, uncompressedSize, compressedSize, storageKey],
      )

      reply.code(put.alreadyExisted ? 200 : 201)
      return { objectId, storageKey, alreadyExisted: put.alreadyExisted }
    },
  })

  app.route({
    method: 'GET',
    url: '/objects/:objectId',
    handler: async (request, reply) => {
      const ctx = await resolveAuth(deps, request)
      if (!ctx) {
        reply.code(401)
        return { error: 'unauthorized' }
      }
      if (!ctx.tenantId) {
        reply.code(403)
        return { error: 'not a member of the requested tenant' }
      }
      const { objectId } = request.params as { objectId: string }
      const rows = await deps.rawExec<{ storage_key: string; tenant: string | null }>(
        `SELECT ro.storage_key, MAX(to_.tenant_id) AS tenant
           FROM "remote_object" ro
           LEFT JOIN "tenant_object" to_ ON to_.object_id = ro.object_id AND to_.tenant_id = $2
           WHERE ro.object_id = $1
           GROUP BY ro.storage_key`,
        [objectId, ctx.tenantId],
      )
      const row = rows[0]
      if (!row) {
        reply.code(404)
        return { error: 'not found' }
      }
      if (!row.tenant) {
        reply.code(403)
        return { error: 'tenant has no access to this object' }
      }
      const stream = await deps.objectStore.get(row.storage_key)
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          total += value.byteLength
        }
      }
      const out = Buffer.alloc(total)
      let offset = 0
      for (const c of chunks) {
        out.set(c, offset)
        offset += c.byteLength
      }
      reply.header('content-type', 'application/octet-stream')
      reply.header('content-length', String(out.byteLength))
      return reply.send(out)
    },
  })
}
