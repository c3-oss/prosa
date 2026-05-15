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

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export class ProsaApiClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  token: string | undefined
  tenantId: string | undefined

  constructor(opts: ProsaApiClientOptions) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl)
    this.fetchFn = opts.fetch ?? globalThis.fetch
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
    const parsed = JSON.parse(text) as TrpcSuccess<T> | TrpcFailure
    if ('error' in parsed) {
      throw new CliUserError(`${path}: ${parsed.error.message}`)
    }
    return parsed.result.data
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
    const response = await this.fetchFn(`${this.baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: input.email, password: input.password }),
    })
    const text = await response.text()
    if (!response.ok) throw new CliUserError(`sign-in failed: ${response.status} ${text}`)
    const body = JSON.parse(text) as { token?: string; user?: { id: string; email: string; name: string } }
    if (!body.token || !body.user) {
      throw new CliUserError('sign-in did not return a token')
    }
    return { token: body.token, user: body.user }
  }

  async deviceCode(input: { clientId?: string } = {}) {
    return this.trpcMutation<{
      deviceCode: string
      userCode: string
      verificationUri: string
      verificationUriComplete: string | null
      expiresIn: number
      interval: number
    }>('auth.deviceCode', { clientId: input.clientId ?? 'prosa-cli' })
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
