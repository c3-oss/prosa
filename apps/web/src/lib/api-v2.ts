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
  kind: string
  text: string | null
  artifactRef?: { kind: string; messageBlockId: string; bodyDigest?: string | null } | null
}
export type V2TranscriptToolResult = { toolResultId: string; status: string | null; summary: string | null }
export type V2TranscriptToolCall = {
  toolCallId: string
  toolName: string | null
  startedAt: string | null
  endedAt: string | null
  result: V2TranscriptToolResult | null
}
export type V2TranscriptTurn = {
  turnId: string
  role: string
  startedAt: string | null
  endedAt: string | null
  blocks: V2TranscriptBlock[]
  toolCalls: V2TranscriptToolCall[]
}
export type V2TranscriptResponse = { sessionId: string; turns: V2TranscriptTurn[]; nextCursor: string | null }

export type V2SearchInput = {
  q: string
  cursor?: string | null
  limit?: number
  role?: string
  toolName?: string
  canonicalType?: string
  errorsOnly?: boolean
  sourceTools?: string[]
  projectIds?: string[]
  storeIds?: string[]
}
export type V2SearchHit = {
  id: string
  sessionId: string
  sessionTitle: string | null
  sourceTool: string
  timestamp: string | null
  role: string | null
  toolName: string | null
  canonicalType: string
  fieldKind: string
  snippet: string
  rank: number | null
  storeId: string
  receiptId: string
}
export type V2SearchResponse = { rows: V2SearchHit[]; nextCursor: string | null }

export type V2ToolCallsInput = {
  cursor?: string | null
  limit?: number
  sourceTools?: string[]
  toolNames?: string[]
  sessionIds?: string[]
  errorsOnly?: boolean
  since?: string
  until?: string
}
export type V2ToolCallHit = {
  toolCallId: string
  sessionId: string
  storeId: string
  receiptId: string
  toolName: string | null
  startedAt: string | null
  endedAt: string | null
  status: string | null
  summary: string | null
  resultStatus: string | null
}
export type V2ToolCallsResponse = { rows: V2ToolCallHit[]; nextCursor: string | null }

export type V2AnalyticsReportInput = {
  report: 'sessions' | 'tools' | 'errors' | 'models' | 'projects'
  cursor?: string | null
  limit?: number
  since?: string
  until?: string
  sourceTools?: string[]
  projectIds?: string[]
}
export type V2AnalyticsReportResponse = {
  rows: Array<Record<string, unknown>>
  nextCursor: string | null
  report: string
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
    }
  }
}

export function createV2ApiClient(opts: CreateV2ClientOptions): V2ApiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const baseUrl = opts.config.apiUrl.replace(/\/+$/, '')

  async function post<T>(route: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/json',
    }
    const tenantId = opts.getTenantId?.() ?? null
    if (tenantId) headers[TENANT_HEADER] = tenantId

    const response = await fetchFn(`${baseUrl}${route}`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(body ?? {}),
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
      },
    },
  }
}
