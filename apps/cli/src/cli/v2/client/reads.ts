// Lane 7 — typed v2 read API client.
//
// Thin HTTP wrapper around the `/v2/reads/*` endpoints shipped by
// Lane 6. The shapes are pinned to the server route schemas
// verbatim (see `apps/api/src/v2/reads/*`); deviations are caught
// by `apps/cli/test/v2/reads-client-contract.test.ts`.

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

// ───── sessions/list + count ─────────────────────────────────────────

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

export type CountSessionsInput = Omit<SessionListInput, 'cursor' | 'limit'>
export type CountSessionsResponse = { count: number }

// ───── sessions/transcript ───────────────────────────────────────────

export type TranscriptPageInput = {
  sessionId: string
  cursor?: string | null
  limit?: number
}

export type TranscriptBlock = {
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

export type TranscriptToolResult = {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
}

export type TranscriptToolCall = {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  status: string | null
  timestampStart: string | null
  result: TranscriptToolResult | null
}

export type TranscriptTurn = {
  messageId: string
  ordinal: number
  turnId: string | null
  role: string
  model: string | null
  timestamp: string | null
  blocks: TranscriptBlock[]
  toolCalls: TranscriptToolCall[]
}

export type TranscriptSession = {
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

export type TranscriptPageBody = {
  session: TranscriptSession
  turns: TranscriptTurn[]
  unattachedToolCalls: TranscriptToolCall[]
  nextCursor: string | null
}

/** The server returns `null` when the session does not exist in the current authority. */
export type TranscriptPageResponse = TranscriptPageBody | null

// ───── search/query ──────────────────────────────────────────────────

export type SearchQueryInput = {
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

export type SearchHit = {
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

export type SearchQueryResponse = { rows: SearchHit[]; nextCursor: string | null }

// ───── tool-calls/list ───────────────────────────────────────────────

export type ToolCallsListInput = {
  cursor?: string | null
  limit?: number
  sessionId?: string
  toolNames?: string[]
  canonicalToolTypes?: string[]
  errorsOnly?: boolean
  since?: string
  until?: string
}

export type ToolCallHit = {
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

export type ToolCallsListResponse = { rows: ToolCallHit[]; nextCursor: string | null }

// ───── analytics/report ──────────────────────────────────────────────

export type AnalyticsReportKind = 'sessions' | 'tools' | 'errors' | 'models' | 'projects'

export type AnalyticsReportInput = {
  report: AnalyticsReportKind
  sourceTools?: string[]
  since?: string
  until?: string
  limit?: number
}

export type AnalyticsReportRow = Record<string, string | number | null>

export type AnalyticsReportResponse = {
  report: AnalyticsReportKind
  generatedAt: string
  rows: AnalyticsReportRow[]
}

// ───── artifacts/getText ─────────────────────────────────────────────

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

// ───── client ────────────────────────────────────────────────────────

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
  countSessions(input: CountSessionsInput): Promise<CountSessionsResponse> {
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
      // non-JSON error body
    }
    const code = envelope.code ?? `HTTP_${response.status}`
    const message = envelope.message ?? text.slice(0, 240) ?? `HTTP ${response.status}`
    const retryAfter = response.headers.get('retry-after')
    const retrySeconds = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : undefined
    throw new V2ReadsError(route, response.status, code, `${route}: ${message}`, retrySeconds)
  }
}
