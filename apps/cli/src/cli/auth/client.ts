import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  type CommitUploadInput,
  type CommitUploadOutput,
  type HandshakeInput,
  type HandshakeOutput,
  OBJECT_PACK_BINARY_CONTENT_TYPE,
  type ObjectManifestEntry,
  type ObjectPackWireEntry,
  type PlanUploadInput,
  type PlanUploadOutput,
  type PromotionReceipt,
  type VerifyPromotionInput,
  type VerifyPromotionOutput,
  encodeBinaryObjectPack,
} from '@c3-oss/prosa-sync'
import { CliUserError } from '../errors.js'

export type ProsaApiClientOptions = {
  baseUrl: string
  token?: string
  tenantId?: string
  onRetry?: (event: ProsaApiRetryEvent) => void
  onRequestSuccess?: (event: ProsaApiRequestSuccessEvent) => void
  /** Optional inject point for tests. */
  fetch?: typeof fetch
}

type TrpcSuccess<T> = { result: { data: T } }
type TrpcFailure = { error: { message: string; data?: { code?: string } } }
type PlainHttpResponse = { ok: boolean; status: number; text: string }
type PreparedObjectPackUpload = { entries: ObjectPackWireEntry[]; payload: Buffer }
type TrpcMutationOptions = {
  headers?: Record<string, string>
  retryStructuredErrorsOnRetryableStatus?: boolean
}
type RetriableFetchOptions = {
  operation: string
  request: () => Promise<Response>
  parse: (response: Response) => Promise<unknown>
  retryHttpStatusBeforeParse?: boolean
  retryParseErrorsOnRetryableStatus?: boolean
  retryStructuredErrorsOnRetryableStatus?: boolean
}

export type ProsaApiRetryEvent = {
  operation: string
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: string
}

export type ProsaApiRequestSuccessEvent = {
  operation: string
  attempts: number
}

export type ObjectPackUploadEntry = ObjectManifestEntry & {
  bytes: Uint8Array
}

export type ObjectPackUploadOutput = {
  blobId: string
  objectIds: string[]
  alreadyExisted: boolean
}

const OBJECT_UPLOAD_MAX_ATTEMPTS = 6
const OBJECT_UPLOAD_BASE_BACKOFF_MS = 500
const OBJECT_UPLOAD_MAX_BACKOFF_MS = 15_000

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function retryAfterSecondsFromMessage(message: string): number | undefined {
  const match = /\bRetry after\s+(\d+)s\b/i.exec(message)
  if (!match) return undefined
  const seconds = Number(match[1])
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return undefined
}

function objectUploadBackoffMs(attempt: number, headers?: Headers): number {
  const retryAfter = headers ? retryAfterMs(headers) : undefined
  if (retryAfter !== undefined) return retryAfter
  const exponential = Math.min(OBJECT_UPLOAD_MAX_BACKOFF_MS, OBJECT_UPLOAD_BASE_BACKOFF_MS * 2 ** attempt)
  return Math.floor(exponential + Math.random() * Math.min(250, exponential))
}

function isRetryableObjectUploadStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true
  if (!(err instanceof Error)) return false
  const code =
    (err as Error & { code?: string; cause?: { code?: string } }).code ??
    (err.cause as { code?: string } | undefined)?.code
  return (
    code != null &&
    ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)
  )
}

function networkErrorReason(err: unknown): string {
  if (err instanceof Error) {
    const code =
      (err as Error & { code?: string; cause?: { code?: string } }).code ??
      (err.cause as { code?: string } | undefined)?.code
    return code ? `${err.message} (${code})` : err.message
  }
  return String(err)
}

function isUnsupportedBinaryObjectPackResponse(status: number, text: string): boolean {
  return status === 415 || (status === 400 && /Unsupported Media Type|JSON body required/i.test(text))
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
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
  private readonly onRetry: ((event: ProsaApiRetryEvent) => void) | undefined
  private readonly onRequestSuccess: ((event: ProsaApiRequestSuccessEvent) => void) | undefined
  token: string | undefined
  tenantId: string | undefined

  constructor(opts: ProsaApiClientOptions) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl)
    this.fetchFn = opts.fetch ?? globalThis.fetch
    this.hasInjectedFetch = Boolean(opts.fetch)
    this.onRetry = opts.onRetry
    this.onRequestSuccess = opts.onRequestSuccess
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

  private async trpcMutation<T>(path: string, input: unknown, opts: TrpcMutationOptions = {}): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}/trpc/${path}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', ...opts.headers }),
      body: JSON.stringify(input ?? {}),
    })
    return this.parseTrpc<T>(path, response)
  }

  private async trpcMutationRetriable<T>(
    path: string,
    input: unknown,
    opts: TrpcMutationOptions & { operation: string },
  ): Promise<T> {
    return this.retriableFetch<T>({
      operation: opts.operation,
      retryHttpStatusBeforeParse: false,
      retryParseErrorsOnRetryableStatus: true,
      retryStructuredErrorsOnRetryableStatus: opts.retryStructuredErrorsOnRetryableStatus,
      request: () =>
        this.fetchFn(`${this.baseUrl}/trpc/${path}`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json', ...opts.headers }),
          body: JSON.stringify(input ?? {}),
        }),
      parse: (response) => this.parseTrpc<T>(path, response),
    })
  }

  private async retriableFetch<T>(opts: RetriableFetchOptions): Promise<T> {
    const { operation, request, parse } = opts
    let lastError: unknown
    for (let attempt = 0; attempt < OBJECT_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      let response: Response
      try {
        response = await request()
      } catch (err) {
        lastError = err
        if (!isRetryableNetworkError(err) || attempt >= OBJECT_UPLOAD_MAX_ATTEMPTS - 1) {
          throw this.wrapRetriedError(operation, attempt + 1, err)
        }
        const delayMs = objectUploadBackoffMs(attempt)
        this.onRetry?.({
          operation,
          attempt: attempt + 1,
          maxAttempts: OBJECT_UPLOAD_MAX_ATTEMPTS,
          delayMs,
          reason: networkErrorReason(err),
        })
        await sleep(delayMs)
        continue
      }

      if (
        opts.retryHttpStatusBeforeParse !== false &&
        isRetryableObjectUploadStatus(response.status) &&
        attempt < OBJECT_UPLOAD_MAX_ATTEMPTS - 1
      ) {
        const delayMs = objectUploadBackoffMs(attempt, response.headers)
        this.onRetry?.({
          operation,
          attempt: attempt + 1,
          maxAttempts: OBJECT_UPLOAD_MAX_ATTEMPTS,
          delayMs,
          reason: `HTTP ${response.status}`,
        })
        await response.arrayBuffer().catch(() => undefined)
        await sleep(delayMs)
        continue
      }

      try {
        const parsed = (await parse(response)) as T
        this.onRequestSuccess?.({ operation, attempts: attempt + 1 })
        return parsed
      } catch (err) {
        if (
          opts.retryParseErrorsOnRetryableStatus &&
          (opts.retryStructuredErrorsOnRetryableStatus !== false || !(err instanceof ProsaApiError)) &&
          isRetryableObjectUploadStatus(response.status) &&
          attempt < OBJECT_UPLOAD_MAX_ATTEMPTS - 1
        ) {
          const delayMs = objectUploadBackoffMs(attempt, response.headers)
          this.onRetry?.({
            operation,
            attempt: attempt + 1,
            maxAttempts: OBJECT_UPLOAD_MAX_ATTEMPTS,
            delayMs,
            reason: `HTTP ${response.status}: ${networkErrorReason(err)}`,
          })
          await sleep(delayMs)
          continue
        }
        throw this.wrapRetriedError(operation, attempt + 1, err)
      }
    }
    throw this.wrapRetriedError(operation, OBJECT_UPLOAD_MAX_ATTEMPTS, lastError)
  }

  private wrapRetriedError(operation: string, attempts: number, err: unknown): Error {
    if (err instanceof ProsaApiError) return err
    if (attempts <= 1) return err instanceof Error ? err : new Error(String(err))
    const reason = networkErrorReason(err)
    return new CliUserError(`${operation} failed after ${attempts} attempts: ${reason}`)
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

  async syncCommitUpload(
    input: CommitUploadInput,
    opts: { idempotencyKey?: string } = {},
  ): Promise<CommitUploadOutput> {
    return this.trpcMutationRetriable<CommitUploadOutput>('sync.commitUpload', input, {
      operation: 'sync.commitUpload',
      headers: opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : undefined,
      retryStructuredErrorsOnRetryableStatus: false,
    })
  }

  async syncVerifyPromotion(input: VerifyPromotionInput): Promise<VerifyPromotionOutput> {
    return this.trpcMutationRetriable<VerifyPromotionOutput>('sync.verifyPromotion', input, {
      operation: 'sync.verifyPromotion',
    })
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
    return this.uploadObjectBytesOnce(input)
  }

  private async uploadObjectBytesOnce(input: {
    batchId: string
    objectId: string
    hash: string
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
    return this.retriableFetch<{ alreadyExisted: boolean }>({
      operation: 'object PUT upload',
      request: () =>
        this.fetchFn(url.toString(), {
          method: 'PUT',
          headers: this.headers({ 'content-type': 'application/octet-stream' }),
          body: input.bytes,
        }),
      parse: async (response) => {
        const text = await response.text()
        if (response.status >= 400) {
          throw new CliUserError(`object upload failed: ${response.status} ${text}`)
        }
        const parsed = JSON.parse(text) as { alreadyExisted: boolean }
        return { alreadyExisted: Boolean(parsed.alreadyExisted) }
      },
    })
  }

  async uploadObjectPack(input: {
    batchId: string
    objects: ObjectPackUploadEntry[]
  }): Promise<ObjectPackUploadOutput> {
    const url = new URL(`${this.baseUrl}/object-packs`)
    url.searchParams.set('batchId', input.batchId)

    const prepared = this.prepareObjectPackUpload(input.objects)
    const binary = await this.retriableFetch<{ status: number; text: string }>({
      operation: 'object pack binary upload',
      request: () =>
        this.fetchFn(url.toString(), {
          method: 'POST',
          headers: this.headers({ 'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE }),
          body: encodeBinaryObjectPack({ entries: prepared.entries, payload: prepared.payload }),
        }),
      parse: async (response) => ({ status: response.status, text: await response.text() }),
    })
    if (!isUnsupportedBinaryObjectPackResponse(binary.status, binary.text)) {
      return this.parseObjectPackUploadResponse(binary.status, binary.text)
    }

    return this.retriableFetch<ObjectPackUploadOutput>({
      operation: 'object pack JSON upload',
      request: () =>
        this.fetchFn(url.toString(), {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            bytesBase64: prepared.payload.toString('base64'),
            entries: prepared.entries,
          }),
        }),
      parse: async (response) => this.parseObjectPackUploadResponse(response.status, await response.text()),
    })
  }

  private prepareObjectPackUpload(objects: ObjectPackUploadEntry[]): PreparedObjectPackUpload {
    let offset = 0
    const buffers: Buffer[] = []
    const entries: ObjectPackWireEntry[] = objects.map((object) => {
      const bytes = Buffer.from(object.bytes.buffer, object.bytes.byteOffset, object.bytes.byteLength)
      buffers.push(bytes)
      const length = bytes.byteLength
      const entry = {
        objectId: object.objectId,
        hash: object.hash,
        hashAlgorithm: object.hashAlgorithm,
        ...(object.transportHash ? { transportHash: object.transportHash } : {}),
        compression: object.compression,
        compressedSize: object.compressedSize,
        uncompressedSize: object.uncompressedSize,
        ...(object.contentType ? { contentType: object.contentType } : {}),
        offset,
        length,
      }
      offset += length
      return entry
    })

    return { entries, payload: Buffer.concat(buffers, offset) }
  }

  private parseObjectPackUploadResponse(status: number, text: string): ObjectPackUploadOutput {
    if (status >= 400) {
      throw new CliUserError(`object pack upload failed: ${status} ${text}`)
    }
    const parsed = JSON.parse(text) as ObjectPackUploadOutput
    return {
      blobId: parsed.blobId,
      objectIds: Array.isArray(parsed.objectIds) ? parsed.objectIds : [],
      alreadyExisted: Boolean(parsed.alreadyExisted),
    }
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
