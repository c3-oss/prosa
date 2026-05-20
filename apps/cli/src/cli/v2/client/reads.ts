// Lane 7 — typed v2 read API client.
//
// Thin HTTP wrapper around the `/v2/reads/*` endpoints shipped by
// Lane 6. The client carries the caller's Bearer token + tenant
// header on every call, parses error envelopes into rich
// `V2ReadsError` instances, and exposes a 412 hook so callers can
// implement the L12 mid-command refresh policy. The shapes match the
// server route schemas exactly so the CLI does not re-validate
// payloads on the happy path.
//
// Authority refresh lives in `../authority/`; this module deals
// only with the read surface.

export class V2ReadsError extends Error {
  override name = 'V2ReadsError'
  constructor(
    readonly route: string,
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

/** Thrown when the server reports `412 PRECONDITION_FAILED` (receipt no longer current). */
export class AuthorityChangedHttpError extends V2ReadsError {
  override name = 'AuthorityChangedHttpError'
  constructor(route: string, message = 'authority changed mid-command (HTTP 412)') {
    super(route, 412, 'AUTHORITY_CHANGED', message)
  }
}

export type V2ReadsClientOptions = {
  baseUrl: string
  token: string
  tenantId: string
  /** Inject for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
}

export type SessionListInput = {
  cursor?: string | null
  limit?: number
  sourceTools?: string[]
  projectIds?: string[]
  storeIds?: string[]
  since?: string
  until?: string
  q?: string
}

export type SessionRow = {
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

export type SessionListResponse = { rows: SessionRow[]; nextCursor: string | null }

export type CountSessionsResponse = { count: number }

export type TranscriptPageInput = {
  sessionId: string
  cursor?: string | null
  limit?: number
}

export type TranscriptTurn = {
  turnId: string
  role: string
  startedAt: string | null
  endedAt: string | null
  blocks: TranscriptBlock[]
  toolCalls: TranscriptToolCall[]
}

export type TranscriptBlock = {
  blockId: string
  kind: string
  text: string | null
  artifactRef?: { kind: string; messageBlockId: string; bodyDigest?: string | null } | null
}

export type TranscriptToolCall = {
  toolCallId: string
  toolName: string | null
  startedAt: string | null
  endedAt: string | null
  result: TranscriptToolResult | null
}

export type TranscriptToolResult = { toolResultId: string; status: string | null; summary: string | null }

export type TranscriptPageResponse = {
  sessionId: string
  turns: TranscriptTurn[]
  nextCursor: string | null
}

export type SearchQueryInput = {
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

export type SearchHit = {
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

export type SearchQueryResponse = { rows: SearchHit[]; nextCursor: string | null }

export type ToolCallsListInput = {
  cursor?: string | null
  limit?: number
  sourceTools?: string[]
  toolNames?: string[]
  sessionIds?: string[]
  errorsOnly?: boolean
  since?: string
  until?: string
}

export type ToolCallHit = {
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

export type ToolCallsListResponse = { rows: ToolCallHit[]; nextCursor: string | null }

export type AnalyticsReportInput = {
  report: 'sessions' | 'tools' | 'errors' | 'models' | 'projects'
  cursor?: string | null
  limit?: number
  since?: string
  until?: string
  sourceTools?: string[]
  projectIds?: string[]
}

export type AnalyticsReportResponse = {
  rows: Array<Record<string, unknown>>
  nextCursor: string | null
  report: string
}

export type ArtifactGetTextInput = {
  storeId: string
  receiptId: string
  bodyDigest: string
  maxBytes?: number
}

export type ArtifactGetTextResponse = {
  text: string
  truncated: boolean
  bytesReturned: number
  totalBytes: number
}

export class V2ReadsClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  readonly tenantId: string
  readonly token: string

  constructor(opts: V2ReadsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.tenantId = opts.tenantId
    this.fetchFn = opts.fetch ?? globalThis.fetch
  }

  listSessions(input: SessionListInput): Promise<SessionListResponse> {
    return this.post('/v2/reads/sessions/list', input)
  }
  countSessions(input: Omit<SessionListInput, 'cursor' | 'limit'>): Promise<CountSessionsResponse> {
    return this.post('/v2/reads/sessions/count', input)
  }
  getTranscriptPage(input: TranscriptPageInput): Promise<TranscriptPageResponse> {
    return this.post('/v2/reads/sessions/transcript', input)
  }
  searchQuery(input: SearchQueryInput): Promise<SearchQueryResponse> {
    return this.post('/v2/reads/search/query', input)
  }
  listToolCalls(input: ToolCallsListInput): Promise<ToolCallsListResponse> {
    return this.post('/v2/reads/tool-calls/list', input)
  }
  analyticsReport(input: AnalyticsReportInput): Promise<AnalyticsReportResponse> {
    return this.post('/v2/reads/analytics/report', input)
  }
  artifactGetText(input: ArtifactGetTextInput): Promise<ArtifactGetTextResponse> {
    return this.post('/v2/reads/artifacts/getText', input)
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
        'x-prosa-tenant-id': this.tenantId,
      },
      body: JSON.stringify(body ?? {}),
    })
    if (response.status === 412) {
      throw new AuthorityChangedHttpError(route)
    }
    const text = await response.text()
    if (response.status >= 200 && response.status < 300) {
      if (!text) return {} as T
      return JSON.parse(text) as T
    }
    let envelope: { code?: string; message?: string } = {}
    try {
      envelope = JSON.parse(text) as { code?: string; message?: string }
    } catch {
      // Non-JSON error body; fall through to the generic message below.
    }
    const code = envelope.code ?? `HTTP_${response.status}`
    const message = envelope.message ?? text.slice(0, 240) ?? `HTTP ${response.status}`
    const retryAfter = response.headers.get('retry-after')
    const retrySeconds = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : undefined
    throw new V2ReadsError(route, response.status, code, `${route}: ${message}`, retrySeconds)
  }
}
