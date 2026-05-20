// Lane 6 — v2 read API plugin entry.
//
// `registerV2ReadRoutes` mounts the receipt-pinned read surface onto
// the Fastify instance owned by `buildApp`. The plugin reuses the
// same v2 auth context resolver the promotion routes use so a single
// Better Auth session covers writes and reads.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { type V2AuthContext, type V2AuthDeps, resolveV2AuthContext } from '../context.js'
import { artifactGetTextInput, getArtifactText } from './artifacts/get-text.js'
import { AuthorityTtlCache } from './authority-cache.js'
import { type AuthorityRefreshResponse, type CachedAuthority, getAuthority } from './authority.js'
import { searchQuery, searchQueryInput } from './search/query.js'
import { countSessions, countSessionsInput } from './sessions/count.js'
import { getSessionDetail, sessionDetailInput } from './sessions/detail.js'
import { listSessions, listSessionsInput } from './sessions/list.js'
import { getTranscriptPage, transcriptPageInput } from './sessions/transcript.js'
import { listToolCalls, toolCallsListInput } from './tool-calls/list.js'

export type V2ReadRoutesDeps = V2AuthDeps & {
  /**
   * Object store used by `artifacts.getText` for the bounded byte
   * fetch. The store is shared with the promotion routes so a
   * single Better Auth tenant maps to a single bucket / namespace.
   */
  objectStore: RemoteObjectStore
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
  { method: 'POST' as const, url: '/v2/reads/sessions/list' as const, opName: 'ReadSessionsList' as const },
  { method: 'POST' as const, url: '/v2/reads/sessions/count' as const, opName: 'ReadSessionsCount' as const },
  { method: 'POST' as const, url: '/v2/reads/sessions/detail' as const, opName: 'ReadSessionsDetail' as const },
  {
    method: 'POST' as const,
    url: '/v2/reads/sessions/transcript' as const,
    opName: 'ReadSessionsTranscript' as const,
  },
  { method: 'POST' as const, url: '/v2/reads/search/query' as const, opName: 'ReadSearchQuery' as const },
  { method: 'POST' as const, url: '/v2/reads/tool-calls/list' as const, opName: 'ReadToolCallsList' as const },
  { method: 'POST' as const, url: '/v2/reads/artifacts/getText' as const, opName: 'ReadArtifactsGetText' as const },
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

  app.route({
    method: 'POST',
    url: '/v2/reads/sessions/list',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadSessionsList')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = listSessionsInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadSessionsList', issues: parsed.error.issues }
      }
      return await listSessions({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/sessions/count',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadSessionsCount')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = countSessionsInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadSessionsCount', issues: parsed.error.issues }
      }
      return await countSessions({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/sessions/detail',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadSessionsDetail')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = sessionDetailInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadSessionsDetail', issues: parsed.error.issues }
      }
      return await getSessionDetail({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/sessions/transcript',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadSessionsTranscript')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = transcriptPageInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadSessionsTranscript', issues: parsed.error.issues }
      }
      return await getTranscriptPage({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/search/query',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadSearchQuery')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = searchQueryInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadSearchQuery', issues: parsed.error.issues }
      }
      return await searchQuery({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/tool-calls/list',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadToolCallsList')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = toolCallsListInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadToolCallsList', issues: parsed.error.issues }
      }
      return await listToolCalls({ rawExec: deps.rawExec }, gate.tenantId, parsed.data)
    },
  })

  app.route({
    method: 'POST',
    url: '/v2/reads/artifacts/getText',
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await resolveV2AuthContext(deps, req)
      const gate = requireV2Tenant(ctx, reply, 'ReadArtifactsGetText')
      if (!gate) return reply.sent ? undefined : reply
      const parsed = artifactGetTextInput.safeParse(req.body ?? {})
      if (!parsed.success) {
        reply.code(400)
        return { code: 'INVALID_INPUT', op: 'ReadArtifactsGetText', issues: parsed.error.issues }
      }
      return await getArtifactText({ rawExec: deps.rawExec, objectStore: deps.objectStore }, gate.tenantId, parsed.data)
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
export { countSessions, countSessionsInput } from './sessions/count.js'
export type { CountSessionsResponse } from './sessions/count.js'
export { getSessionDetail, sessionDetailInput } from './sessions/detail.js'
export type { SessionDetailResponse } from './sessions/detail.js'
export { listSessions, listSessionsInput } from './sessions/list.js'
export type { ListSessionsResponse, SessionRow } from './sessions/list.js'
export { INLINE_TEXT_BUDGET_BYTES, getTranscriptPage, transcriptPageInput } from './sessions/transcript.js'
export type {
  TranscriptBlock,
  TranscriptPageInput,
  TranscriptPageResponse,
  TranscriptToolCall,
  TranscriptToolResult,
  TranscriptTurn,
} from './sessions/transcript.js'
export { searchQuery, searchQueryInput } from './search/query.js'
export type { SearchHit, SearchQueryInput, SearchQueryResponse } from './search/query.js'
export { listToolCalls, toolCallsListInput } from './tool-calls/list.js'
export type { ToolCallHit, ToolCallsListInput, ToolCallsListResponse } from './tool-calls/list.js'
export {
  ARTIFACT_TEXT_MAX_BYTES_DEFAULT,
  ARTIFACT_TEXT_MAX_BYTES_LIMIT,
  artifactGetTextInput,
  getArtifactText,
} from './artifacts/get-text.js'
export type { ArtifactGetTextInput, ArtifactGetTextResponse } from './artifacts/get-text.js'
export { buildSessionWhere, sessionListFilters } from './sessions/filters.js'
export type { SessionListFilters } from './sessions/filters.js'
export {
  VERIFIED_PROJECTION_TABLES,
  verifiedProjectionWhere,
  verifiedSearchWhere,
} from './shared/verified-projection.js'
export { decodeCursor, encodeCursor } from './shared/cursor.js'
export type { CursorPage, CursorPayload } from './shared/cursor.js'
