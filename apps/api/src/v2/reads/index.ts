// Lane 6 — v2 read API plugin entry.
//
// `registerV2ReadRoutes` mounts the receipt-pinned read surface onto
// the Fastify instance owned by `buildApp`. The plugin reuses the
// same v2 auth context resolver the promotion routes use so a single
// Better Auth session covers writes and reads.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type V2AuthContext, type V2AuthDeps, resolveV2AuthContext } from '../context.js'
import { AuthorityTtlCache } from './authority-cache.js'
import { type AuthorityRefreshResponse, type CachedAuthority, getAuthority } from './authority.js'

export type V2ReadRoutesDeps = V2AuthDeps & {
  /**
   * Optional cache override for tests. Defaults to a 30 s TTL
   * in-process cache; tests inject a smaller-TTL instance to keep
   * the suite fast and deterministic.
   */
  authorityCache?: AuthorityTtlCache<CachedAuthority>
  now?: () => number
}

export type V2ReadPluginHandle = {
  authorityCache: AuthorityTtlCache<CachedAuthority>
}

export const V2_READ_ROUTES = [
  {
    method: 'GET' as const,
    url: '/v2/stores/:storeId/authority' as const,
    opName: 'AuthorityRefresh' as const,
  },
]

export function registerV2ReadRoutes(app: FastifyInstance, deps: V2ReadRoutesDeps): V2ReadPluginHandle {
  const authorityCache = deps.authorityCache ?? new AuthorityTtlCache<CachedAuthority>()
  const now = deps.now

  app.route({
    method: 'GET',
    url: '/v2/stores/:storeId/authority',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'AuthorityRefresh')
      if (!gate) return reply.sent ? undefined : reply
      const params = req.params as { storeId?: string }
      const storeId = (params.storeId ?? '').trim()
      if (!storeId) {
        reply.code(400)
        return { code: 'INVALID_STORE_ID', op: 'AuthorityRefresh' }
      }
      const query = req.query as { knownReceiptId?: string } | undefined
      const knownReceiptId = query?.knownReceiptId?.trim() || null
      const result: AuthorityRefreshResponse = await getAuthority(
        { rawExec: deps.rawExec, cache: authorityCache, now },
        { tenantId: gate.tenantId, storeId, knownReceiptId },
      )
      return result
    },
  })

  return { authorityCache }
}

type GateResult = { tenantId: string } | null

function requireV2Tenant(ctx: V2AuthContext, reply: FastifyReply, opName: string): GateResult {
  if (!ctx.user) {
    reply.code(401)
    reply.send({ code: 'UNAUTHENTICATED', op: opName })
    return null
  }
  if (!ctx.tenantId) {
    reply.code(403)
    reply.send({ code: 'NO_TENANT', op: opName })
    return null
  }
  return { tenantId: ctx.tenantId }
}

export { AuthorityTtlCache, authorityCacheKey } from './authority-cache.js'
export type { AuthorityCacheEntry } from './authority-cache.js'
export { getAuthority } from './authority.js'
export type { AuthorityAuditStatus, AuthorityRefreshResponse, CachedAuthority } from './authority.js'
export {
  verifiedProjectionWhere,
  verifiedSearchWhere,
  VERIFIED_PROJECTION_TABLES,
} from './shared/verified-projection.js'
export { decodeCursor, encodeCursor } from './shared/cursor.js'
export type { CursorPage, CursorPayload } from './shared/cursor.js'
