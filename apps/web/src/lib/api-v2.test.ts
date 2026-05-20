// Lane 7 — focused test for the web v2 data layer.

import { describe, expect, it } from 'vitest'
import { ApiV2Error, AuthorityChangedError, createV2ApiClient } from './api-v2.js'
import type { WebRuntimeConfig } from './config.js'

const CONFIG: WebRuntimeConfig = {
  apiUrl: 'http://test.invalid/',
  appEnv: 'development',
  marketingDocsUrl: null,
  githubUrl: null,
}

function stub<T>(status: number, body: T, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }) as unknown as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

describe('createV2ApiClient', () => {
  it('sends credentials and tenant header on every call', async () => {
    const { fetch: stubFetch, calls } = stub(200, { count: 7 })
    const client = createV2ApiClient({
      config: CONFIG,
      getTenantId: () => 'tenant-42',
      fetch: stubFetch,
    })
    const out = await client.v2.sessions.count({ q: 'hello' })
    expect(out.count).toBe(7)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://test.invalid/v2/reads/sessions/count')
    const init = calls[0]!.init
    expect(init.credentials).toBe('include')
    expect((init.headers as Record<string, string>)['x-prosa-tenant-id']).toBe('tenant-42')
  })

  it('omits the tenant header when no active tenant', async () => {
    const { fetch: stubFetch, calls } = stub(200, { rows: [], nextCursor: null })
    const client = createV2ApiClient({ config: CONFIG, fetch: stubFetch })
    await client.v2.sessions.list({ limit: 10 })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-prosa-tenant-id']).toBeUndefined()
  })

  it('maps HTTP 412 to AuthorityChangedError', async () => {
    const { fetch: stubFetch } = stub(412, { code: 'AUTHORITY_CHANGED' })
    const client = createV2ApiClient({ config: CONFIG, fetch: stubFetch })
    await expect(client.v2.sessions.transcript({ sessionId: 's1' })).rejects.toBeInstanceOf(AuthorityChangedError)
  })

  it('parses error envelopes into ApiV2Error', async () => {
    const { fetch: stubFetch } = stub(400, { code: 'INVALID_INPUT', message: 'bad query' })
    const client = createV2ApiClient({ config: CONFIG, fetch: stubFetch })
    await expect(client.v2.search.query({ q: '' })).rejects.toMatchObject({
      name: 'ApiV2Error',
      status: 400,
      code: 'INVALID_INPUT',
    })
  })

  it('captures retry-after on 429', async () => {
    const { fetch: stubFetch } = stub(429, { code: 'TOO_MANY_REQUESTS' }, { 'retry-after': '8' })
    const client = createV2ApiClient({ config: CONFIG, fetch: stubFetch })
    try {
      await client.v2.toolCalls.list({})
      throw new Error('expected error')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiV2Error)
      expect((err as ApiV2Error).retryAfterSeconds).toBe(8)
    }
  })
})
