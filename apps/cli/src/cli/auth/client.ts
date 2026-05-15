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
      token: string
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

  async signOut(): Promise<void> {
    if (!this.token) return
    await this.fetchFn(`${this.baseUrl}/api/auth/sign-out`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({}),
    })
  }

  async me() {
    return this.trpcQuery<{
      user: { id: string; email: string; name: string } | null
      session: unknown
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
    objectId: string
    hash: string
    compressedSize: number
    uncompressedSize: number
    bytes: Uint8Array
  }): Promise<{ alreadyExisted: boolean }> {
    const url = new URL(`${this.baseUrl}/objects/${input.objectId}`)
    url.searchParams.set('hash', input.hash)
    url.searchParams.set('size', String(input.compressedSize))
    url.searchParams.set('uncompressed', String(input.uncompressedSize))
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

  async listSessions(input: { limit?: number; sourceKind?: string; search?: string } = {}) {
    return this.trpcQuery<
      Array<{
        id: string
        sourceKind: string
        title: string | null
        startedAt: string | null
        endedAt: string | null
        turnCount: number
        projectId: string | null
      }>
    >('sessions.list', input)
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

  async searchQuery(input: { q: string; limit?: number }) {
    return this.trpcQuery<Array<{ id: string; sessionId: string; kind: string; snippet: string }>>(
      'search.query',
      input,
    )
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
