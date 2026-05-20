// Lane 7 — web data-layer v2 client.
//
// Replaces the tRPC client with typed fetch calls against the
// `/v2/reads/*` endpoints shipped by Lane 6. The shapes mirror the
// server route schemas so React Query layers can swap the data
// fetcher without touching the route component.
//
// The browser flow keeps Better Auth session cookies (`credentials:
// 'include'`); the candidate tenant id is sent in the
// `x-prosa-tenant-id` header which the server independently verifies
// against `member` before serving any tenant-scoped row.

import type { WebRuntimeConfig } from './config.js'

const TENANT_HEADER = 'x-prosa-tenant-id'

export class ApiV2Error extends Error {
  override name = 'ApiV2Error'
  constructor(
    readonly route: string,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export class AuthorityChangedError extends ApiV2Error {
  override name = 'AuthorityChangedError'
  constructor(route: string) {
    super(route, 412, 'AUTHORITY_CHANGED', `authority changed mid-call: ${route}`)
  }
}

/**
 * CQ-153 — refuse v2 read calls without an active tenant so the
 * server cannot silently fall back to the session's active org.
 * Thrown before any network request is made.
 */
export class MissingTenantError extends ApiV2Error {
  override name = 'MissingTenantError'
  constructor(route: string) {
    super(route, 0, 'NO_TENANT', `${route} requires an active tenant; sign in and select a tenant before retrying.`)
  }
}

export type CreateV2ClientOptions = {
  config: WebRuntimeConfig
  /** Returns the active tenant id, if any, when each request is built. */
  getTenantId?: () => string | null
  /** Inject for tests. */
  fetch?: typeof fetch
}

export type V2SessionRow = {
  id: string
  sourceTool: string
  sourceSessionId: string
  projectId: string | null
  title: string | null
  summary: string | null
  startedAt: string | null
  endedAt: string | null
  status: string | null
  storeId: string
  receiptId: string
  isSubagent: boolean
  parentSessionId: string | null
  timelineConfidence: string
}

export type V2SessionListInput = {
  cursor?: string | null
  limit?: number
  sourceTools?: string[]
  projectIds?: string[]
  storeIds?: string[]
  since?: string
  until?: string
  q?: string
}

export type V2SessionListResponse = { rows: V2SessionRow[]; nextCursor: string | null }
export type V2CountResponse = { count: number }

export type V2TranscriptInput = { sessionId: string; cursor?: string | null; limit?: number }
export type V2TranscriptBlock = {
  blockId: string
  blockType: string
  ordinal: number
  textInline: string | null
  textObjectId: string | null
  hidden: boolean
  isError: boolean
  isRedacted: boolean
  mimeType: string | null
}
export type V2TranscriptToolResult = {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
}
export type V2TranscriptToolCall = {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  status: string | null
  timestampStart: string | null
  result: V2TranscriptToolResult | null
}
export type V2TranscriptTurn = {
  messageId: string
  ordinal: number
  turnId: string | null
  role: string
  model: string | null
  timestamp: string | null
  blocks: V2TranscriptBlock[]
  toolCalls: V2TranscriptToolCall[]
}
export type V2TranscriptSession = {
  id: string
  sourceTool: string
  sourceSessionId: string
  title: string | null
  startedAt: string | null
  endedAt: string | null
  durationMs: number | null
  storeId: string
  receiptId: string
}
export type V2TranscriptPageBody = {
  session: V2TranscriptSession
  turns: V2TranscriptTurn[]
  unattachedToolCalls: V2TranscriptToolCall[]
  nextCursor: string | null
}
/** The server returns `null` when the session is not in the current authority. */
export type V2TranscriptResponse = V2TranscriptPageBody | null

export type V2SearchInput = {
  q: string
  cursor?: string | null
  limit?: number
  roles?: string[]
  toolNames?: string[]
  canonicalToolTypes?: string[]
  entityTypes?: string[]
  errorsOnly?: boolean
  sessionId?: string
  since?: string
  until?: string
}
export type V2SearchHit = {
  docId: string
  entityType: string
  entityId: string
  sessionId: string | null
  projectId: string | null
  timestamp: string | null
  role: string | null
  toolName: string | null
  canonicalToolType: string | null
  fieldKind: string
  errorsOnly: boolean
  snippet: string
  rank: number
  storeId: string
  receiptId: string
}
export type V2SearchResponse = { rows: V2SearchHit[]; nextCursor: string | null }

export type V2ToolCallsInput = {
  cursor?: string | null
  limit?: number
  sessionId?: string
  toolNames?: string[]
  canonicalToolTypes?: string[]
  errorsOnly?: boolean
  since?: string
  until?: string
}
export type V2ToolCallHit = {
  toolCallId: string
  sessionId: string
  turnId: string | null
  toolName: string
  canonicalToolType: string | null
  status: string | null
  timestampStart: string | null
  storeId: string
  receiptId: string
  latestResult: {
    toolResultId: string
    status: string | null
    isError: boolean
    exitCode: number | null
    durationMs: number | null
  } | null
}
export type V2ToolCallsResponse = { rows: V2ToolCallHit[]; nextCursor: string | null }

export type V2AnalyticsReportKind = 'sessions' | 'tools' | 'errors' | 'models' | 'projects'
export type V2AnalyticsReportInput = {
  report: V2AnalyticsReportKind
  limit?: number
  since?: string
  until?: string
  sourceTools?: string[]
}
export type V2AnalyticsReportRow = Record<string, string | number | null>
export type V2AnalyticsReportResponse = {
  report: V2AnalyticsReportKind
  generatedAt: string
  rows: V2AnalyticsReportRow[]
}

export type V2AnalyticsSummaryResponse = {
  generatedAt: string
  counts: {
    sessions: number
    messages: number
    toolCalls: number
    toolResultErrors: number
    artifacts: number
    searchDocs: number
    stores: number
    sources: number
  }
  sources: Array<{ sourceTool: string; count: number }>
  stores: Array<{ storeId: string; sessionCount: number; latestPromotedAt: string | null }>
}

export type V2ArtifactGetTextInput = {
  storeId: string
  receiptId: string
  bodyDigest: string
  maxBytes?: number
}
export type V2ArtifactGetTextResponse = {
  text: string
  truncated: boolean
  bytesReturned: number
  totalBytes: number
}

export type V2ApiClient = {
  v2: {
    sessions: {
      list: (input: V2SessionListInput) => Promise<V2SessionListResponse>
      count: (input: Omit<V2SessionListInput, 'cursor' | 'limit'>) => Promise<V2CountResponse>
      transcript: (input: V2TranscriptInput) => Promise<V2TranscriptResponse>
    }
    search: {
      query: (input: V2SearchInput) => Promise<V2SearchResponse>
    }
    toolCalls: {
      list: (input: V2ToolCallsInput) => Promise<V2ToolCallsResponse>
    }
    analytics: {
      report: (input: V2AnalyticsReportInput) => Promise<V2AnalyticsReportResponse>
      summary: () => Promise<V2AnalyticsSummaryResponse>
    }
    artifacts: {
      getText: (input: V2ArtifactGetTextInput) => Promise<V2ArtifactGetTextResponse>
    }
  }
}

export function createV2ApiClient(opts: CreateV2ClientOptions): V2ApiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.config.apiUrl.replace(/\/+$/, '')

  async function request<T>(route: string, method: 'GET' | 'POST', body: unknown): Promise<T> {
    const tenantId = opts.getTenantId?.() ?? null
    if (!tenantId) {
      // CQ-153: fail closed before the network round-trip. The
      // server independently checks tenant membership but never
      // letting the request reach it removes any chance of a
      // session-active-org fallback masking a missing tenant.
      throw new MissingTenantError(route)
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      [TENANT_HEADER]: tenantId,
    }
    if (method === 'POST') headers['content-type'] = 'application/json'

    const response = await fetchFn(`${baseUrl}${route}`, {
      method,
      credentials: 'include',
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
    if (response.status === 412) throw new AuthorityChangedError(route)

    const text = await response.text()
    if (response.status >= 200 && response.status < 300) {
      if (!text) return {} as T
      return JSON.parse(text) as T
    }
    let envelope: { code?: string; message?: string } = {}
    try {
      envelope = JSON.parse(text) as { code?: string; message?: string }
    } catch {
      // non-JSON error body
    }
    const code = envelope.code ?? `HTTP_${response.status}`
    const message = envelope.message ?? text.slice(0, 240) ?? `HTTP ${response.status}`
    const retryAfter = response.headers.get('retry-after')
    const retrySeconds = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : undefined
    throw new ApiV2Error(route, response.status, code, message, retrySeconds)
  }

  const post = <T>(route: string, body: unknown) => request<T>(route, 'POST', body)
  const get = <T>(route: string) => request<T>(route, 'GET', undefined)

  return {
    v2: {
      sessions: {
        list: (input) => post('/v2/reads/sessions/list', input),
        count: (input) => post('/v2/reads/sessions/count', input),
        transcript: (input) => post('/v2/reads/sessions/transcript', input),
      },
      search: {
        query: (input) => post('/v2/reads/search/query', input),
      },
      toolCalls: {
        list: (input) => post('/v2/reads/tool-calls/list', input),
      },
      analytics: {
        report: (input) => post('/v2/reads/analytics/report', input),
        summary: () => get('/v2/reads/analytics/summary'),
      },
      artifacts: {
        getText: (input) => post('/v2/reads/artifacts/getText', input),
      },
    },
  }
}
