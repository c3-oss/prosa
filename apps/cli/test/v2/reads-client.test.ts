// Lane 7 slice 1 — focused test for the typed v2 reads client.
//
// Pins the contract:
//   - the client carries Authorization + tenant headers,
//   - it parses error envelopes into V2ReadsError,
//   - HTTP 412 surfaces as AuthorityChangedHttpError so callers can
//     run the L12 refresh policy.

import { describe, expect, it } from 'vitest'
import { AuthorityChangedHttpError, V2ReadsClient, V2ReadsError } from '../../src/cli/v2/client/index.js'

function stub<T>(
  status: number,
  body: T,
  headers: Record<string, string> = {},
): {
  fetch: typeof fetch
  calls: { url: string; init: RequestInit }[]
} {
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

describe('V2ReadsClient', () => {
  it('carries auth and tenant headers and parses session list responses', async () => {
    const { fetch: stubFetch, calls } = stub(200, {
      rows: [
        {
          id: 'sess-1',
          sourceTool: 'codex',
          sourceSessionId: 'src',
          projectId: null,
          title: 't',
          summary: null,
          startedAt: '2026-05-20T00:00:00.000Z',
          endedAt: null,
          status: 'ok',
          storeId: 'store',
          receiptId: 'r1',
          isSubagent: false,
          parentSessionId: null,
          timelineConfidence: 'high',
        },
      ],
      nextCursor: null,
    })
    const client = new V2ReadsClient({
      baseUrl: 'http://test.invalid/',
      token: 'tok',
      tenantId: 'ten',
      fetch: stubFetch,
    })
    const out = await client.listSessions({ limit: 25 })
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.id).toBe('sess-1')
    expect(calls).toHaveLength(1)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['x-prosa-tenant-id']).toBe('ten')
    expect(calls[0]!.url).toBe('http://test.invalid/v2/reads/sessions/list')
  })

  it('parses error envelopes into V2ReadsError', async () => {
    const { fetch: stubFetch } = stub(400, { code: 'INVALID_INPUT', message: 'bad limit' })
    const client = new V2ReadsClient({ baseUrl: 'http://test.invalid', token: 't', tenantId: 'x', fetch: stubFetch })
    await expect(client.countSessions({})).rejects.toMatchObject({
      name: 'V2ReadsError',
      statusCode: 400,
      code: 'INVALID_INPUT',
    })
    await expect(client.countSessions({})).rejects.toBeInstanceOf(V2ReadsError)
  })

  it('maps HTTP 412 to AuthorityChangedHttpError', async () => {
    const { fetch: stubFetch } = stub(412, { code: 'AUTHORITY_CHANGED' })
    const client = new V2ReadsClient({ baseUrl: 'http://test.invalid', token: 't', tenantId: 'x', fetch: stubFetch })
    await expect(client.getTranscriptPage({ sessionId: 'sess-1' })).rejects.toBeInstanceOf(AuthorityChangedHttpError)
  })

  it('captures retry-after seconds when the server rate-limits', async () => {
    const { fetch: stubFetch } = stub(429, { code: 'TOO_MANY_REQUESTS' }, { 'retry-after': '12' })
    const client = new V2ReadsClient({ baseUrl: 'http://test.invalid', token: 't', tenantId: 'x', fetch: stubFetch })
    try {
      await client.searchQuery({ q: 'hello' })
      throw new Error('expected error')
    } catch (err) {
      expect(err).toBeInstanceOf(V2ReadsError)
      expect((err as V2ReadsError).retryAfterSeconds).toBe(12)
    }
  })
})
