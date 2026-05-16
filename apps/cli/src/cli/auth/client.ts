import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type {
  CommitUploadInput,
  CommitUploadOutput,
  HandshakeInput,
  HandshakeOutput,
  PlanUploadInput,
  PlanUploadOutput,
  PromotionReceipt,
  VerifyPromotionInput,
  VerifyPromotionOutput,
} from '@c3-oss/prosa-sync'
import { CliUserError } from '../errors.js'

export type ProsaApiClientOptions = {
  baseUrl: string
  token?: string
  tenantId?: string
  /** Optional inject point for tests. */
  fetch?: typeof fetch
}

type TrpcSuccess<T> = { result: { data: T } }
type TrpcFailure = { error: { message: string; data?: { code?: string } } }
type PlainHttpResponse = { ok: boolean; status: number; text: string }

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function retryAfterSecondsFromMessage(message: string): number | undefined {
  const match = /\bRetry after\s+(\d+)s\b/i.exec(message)
  if (!match) return undefined
  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function embeddedAbsoluteUrl(value: URL): string | null {
  const path = value.pathname.startsWith('/') ? value.pathname.slice(1) : value.pathname
  const candidates = [path]
  try {
    candidates.push(decodeURIComponent(path))
  } catch {
    // Leave malformed escape sequences untouched.
  }
  for (const candidate of candidates) {
    if (!/^https?:\/\//i.test(candidate)) continue
    try {
      return new URL(`${candidate}${value.search}${value.hash}`).toString()
    } catch {
      // Fall through to the next candidate.
    }
  }
  return null
}

function normalizeDeviceUri(baseUrl: string, value: string | null): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return trimmed
  try {
    const parsed = new URL(trimmed)
    return embeddedAbsoluteUrl(parsed) ?? parsed.toString()
  } catch {
    return new URL(trimmed, `${trimTrailingSlash(baseUrl)}/`).toString()
  }
}

async function postJsonWithoutFetchMetadata(urlString: string, body: unknown): Promise<PlainHttpResponse> {
  const url = new URL(urlString)
  const payload = JSON.stringify(body ?? {})
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString(),
          'user-agent': 'prosa-cli',
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, text })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

export class ProsaApiError extends CliUserError {
  readonly code: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(path: string, message: string, opts: { code?: string; retryAfterSeconds?: number } = {}) {
    super(`${path}: ${message}`)
    this.name = 'ProsaApiError'
    this.code = opts.code
    this.retryAfterSeconds = opts.retryAfterSeconds
  }
}

export class ProsaApiClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly hasInjectedFetch: boolean
  token: string | undefined
  tenantId: string | undefined

  constructor(opts: ProsaApiClientOptions) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl)
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.hasInjectedFetch = Boolean(opts.fetch)
    this.token = opts.token
    this.tenantId = opts.tenantId
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = { ...extra }
    if (this.token) out.authorization = `Bearer ${this.token}`
    if (this.tenantId) out['x-prosa-tenant-id'] = this.tenantId
    return out
  }

  private async trpcQuery<T>(path: string, input?: unknown): Promise<T> {
    const url = new URL(`${this.baseUrl}/trpc/${path}`)
    if (input !== undefined) url.searchParams.set('input', JSON.stringify(input))
    const response = await this.fetchFn(url.toString(), { headers: this.headers() })
    return this.parseTrpc<T>(path, response)
  }

  private async trpcMutation<T>(path: string, input: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}/trpc/${path}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(input ?? {}),
    })
    return this.parseTrpc<T>(path, response)
  }

  private async parseTrpc<T>(path: string, response: Response): Promise<T> {
    const text = await response.text()
    if (!text) throw new CliUserError(`${path}: empty response (status ${response.status})`)
    let parsed: TrpcSuccess<T> | TrpcFailure
    try {
      parsed = JSON.parse(text) as TrpcSuccess<T> | TrpcFailure
    } catch {
      const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text
      throw new CliUserError(`${path}: non-JSON response (status ${response.status}): ${preview}`)
    }
    if ('error' in parsed) {
      const message = parsed.error.message ?? `request failed with status ${response.status}`
      throw new ProsaApiError(path, message, {
        code: parsed.error.data?.code,
        retryAfterSeconds: retryAfterSecondsFromMessage(message),
      })
    }
    return parsed.result.data
  }

  private async postJsonForCliAuth(path: string, body: unknown): Promise<PlainHttpResponse> {
    if (!this.hasInjectedFetch) {
      return postJsonWithoutFetchMetadata(`${this.baseUrl}${path}`, body)
    }
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { ok: response.ok, status: response.status, text: await response.text() }
  }

  // ---- auth ----

  async signupWithTenant(input: {
    email: string
    password: string
    name: string
    tenantName: string
    tenantSlug?: string
  }) {
    return this.trpcMutation<{
      /**
       * Token is present when the caller is the CLI / API-origin client.
       * Browser-origin callers receive the cookie-only response (CQ-007)
       * and no token reaches JavaScript.
       */
      token?: string
      user: { id: string; email: string; name: string }
      tenant: { id: string; name: string; slug: string | null }
    }>('auth.signupWithTenant', input)
  }

  /** Email/password login via Better Auth's mounted REST handler. */
  async signInEmail(input: { email: string; password: string }) {
    const response = await this.postJsonForCliAuth('/api/auth/sign-in/email', {
      email: input.email,
      password: input.password,
    })
    const text = response.text
    if (!response.ok) throw new CliUserError(`sign-in failed: ${response.status} ${text}`)
    const body = JSON.parse(text) as { token?: string; user?: { id: string; email: string; name: string } }
    if (!body.token || !body.user) {
      throw new CliUserError('sign-in did not return a token')
    }
    return { token: body.token, user: body.user }
  }

  async deviceCode(input: { clientId?: string } = {}) {
    const result = await this.trpcMutation<{
      deviceCode: string
      userCode: string
      verificationUri: string
      verificationUriComplete: string | null
      expiresIn: number
      interval: number
    }>('auth.deviceCode', { clientId: input.clientId ?? 'prosa-cli' })
    return {
      ...result,
      verificationUri: normalizeDeviceUri(this.baseUrl, result.verificationUri) ?? result.verificationUri,
      verificationUriComplete: normalizeDeviceUri(this.baseUrl, result.verificationUriComplete),
    }
  }

  async deviceToken(input: { deviceCode: string; clientId?: string }) {
    return this.trpcMutation<
      | { pending: true; code: string }
      | { pending: false; token: string; user: { id: string; email: string; name: string } | null }
    >('auth.deviceToken', { deviceCode: input.deviceCode, clientId: input.clientId ?? 'prosa-cli' })
  }

  async signOut(): Promise<void> {
    if (!this.token) return
    const response = await this.fetchFn(`${this.baseUrl}/api/auth/sign-out`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    })
    if (!response.ok) {
      const text = await response.text()
      throw new CliUserError(`sign-out failed: ${response.status} ${text}`)
    }
  }

  async me() {
    return this.trpcQuery<{
      user: { id: string; email: string; name: string } | null
      session: { expiresAt?: string; expires_at?: string } | null
      tenantId: string | null
      memberRole: string | null
    }>('auth.me')
  }

  async listTenants() {
    return this.trpcQuery<Array<{ id: string; name: string; slug: string | null }>>('tenant.list')
  }

  async setActiveTenant(tenantId: string) {
    return this.trpcMutation<{ tenantId: string }>('tenant.setActive', { tenantId })
  }

  async invite(input: { email: string; role?: 'admin' | 'member' }) {
    return this.trpcMutation('tenant.invite', input)
  }

  // ---- sync ----

  async syncHandshake(input: HandshakeInput): Promise<HandshakeOutput> {
    return this.trpcMutation<HandshakeOutput>('sync.handshake', input)
  }

  async syncPlanUpload(input: PlanUploadInput): Promise<PlanUploadOutput> {
    return this.trpcMutation<PlanUploadOutput>('sync.planUpload', input)
  }

  async syncCommitUpload(input: CommitUploadInput): Promise<CommitUploadOutput> {
    return this.trpcMutation<CommitUploadOutput>('sync.commitUpload', input)
  }

  async syncVerifyPromotion(input: VerifyPromotionInput): Promise<VerifyPromotionOutput> {
    return this.trpcMutation<VerifyPromotionOutput>('sync.verifyPromotion', input)
  }

  async syncAckCleanup(input: { batchId: string; storePath: string; removedPaths: string[] }) {
    return this.trpcMutation('sync.ackCleanup', input)
  }

  async syncStatus(storePath?: string) {
    return this.trpcQuery<{ authorities: unknown[] }>('sync.status', storePath ? { storePath } : undefined)
  }

  async uploadObjectBytes(input: {
    batchId: string
    objectId: string
    /** BLAKE3 of the original payload (canonical). */
    hash: string
    /** BLAKE3 of the bytes-on-the-wire; defaults to `hash` when none is given. */
    transportHash?: string
    compression?: 'zstd' | 'none'
    compressedSize: number
    uncompressedSize: number
    bytes: Uint8Array
  }): Promise<{ alreadyExisted: boolean }> {
    const url = new URL(`${this.baseUrl}/objects/${input.objectId}`)
    url.searchParams.set('batchId', input.batchId)
    url.searchParams.set('hash', input.hash)
    url.searchParams.set('size', String(input.compressedSize))
    url.searchParams.set('uncompressed', String(input.uncompressedSize))
    url.searchParams.set('compression', input.compression ?? 'zstd')
    if (input.transportHash) url.searchParams.set('transportHash', input.transportHash)
    const response = await this.fetchFn(url.toString(), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
      body: input.bytes,
    })
    const text = await response.text()
    if (response.status >= 400) {
      throw new CliUserError(`object upload failed: ${response.status} ${text}`)
    }
    const parsed = JSON.parse(text) as { alreadyExisted: boolean }
    return { alreadyExisted: Boolean(parsed.alreadyExisted) }
  }

  // ---- reads ----

  async listSessions(
    input: { limit?: number; sourceKinds?: string[]; q?: string; since?: string; until?: string; cursor?: string } = {},
  ) {
    return this.trpcQuery<{
      rows: Array<{
        id: string
        sourceKind: string
        title: string | null
        startedAt: string | null
        endedAt: string | null
        turnCount: number
        projectId: string | null
        messageCount: number
        toolCallCount: number
        errorCount: number
        durationMs: number | null
      }>
      nextCursor: string | null
    }>('sessions.list', input)
  }

  async countSessions(input: { sourceKinds?: string[]; q?: string; since?: string; until?: string } = {}) {
    return this.trpcQuery<{ count: number }>('sessions.count', input)
  }

  async getSession(id: string) {
    return this.trpcQuery<{
      id: string
      sourceKind: string
      title: string | null
      startedAt: string | null
      endedAt: string | null
      turnCount: number
      projectId: string | null
      metadata: unknown
    } | null>('sessions.get', { id })
  }

  async searchQuery(input: { q: string; limit?: number; cursor?: string }) {
    return this.trpcQuery<{
      rows: Array<{
        id: string
        sessionId: string
        sessionTitle: string | null
        sourceKind: string
        timestamp: string | null
        role: string | null
        toolName: string | null
        fieldKind: string
        snippet: string
        rank: number | null
      }>
      nextCursor: string | null
    }>('search.query', input)
  }

  async analyticsSummary() {
    return this.trpcQuery<{
      counts: { sessions: number; objects: number; docs: number; sources: number }
      sources: Array<{ sourceKind: string; count: number }>
    }>('analytics.summary')
  }

  // ---- promotion receipt helper ----

  formatReceipt(receipt: PromotionReceipt): string {
    return `batch ${receipt.batchId} • ${receipt.sessionCount} sessions • ${receipt.objectCount} objects • ${receipt.searchDocCount} search docs`
  }
}
