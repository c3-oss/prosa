// Lane 6 / CQ-142 acceptance — HTTP route-level cursor integrity.
//
// Every paginated v2 route must return HTTP 400 / `INVALID_CURSOR`
// when the caller presents an invalid, wrong-signed, or empty
// cursor. Handler-level coverage exists in `cursor-integrity.test.ts`
// and `cursor-snapshot.test.ts`; this suite locks the wire response.

import { describe, expect, it } from 'vitest'
import { createInProcessCursorSigner } from '../../../src/v2/reads/shared/cursor-signer.js'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  // Tenant slug regex requires `[a-z0-9-]+`; lower-case everything
  // to keep camelCase op-name suffixes valid.
  const normalizedSlug = slug.toLowerCase()
  const r = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: name,
      tenantSlug: normalizedSlug,
    } as never,
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { result: { data: { token: string; user: { id: string }; tenant: { id: string } } } }).result.data
}

// Sign a cursor with a foreign signer so the value is well-formed
// base64.base64 but won't verify against the server's key.
function foreignCursor(): string {
  const foreign = createInProcessCursorSigner()
  return foreign.sign({
    startedAt: '2026-05-19T10:00:00Z',
    id: 'ses_attacker_pick',
    snapshot: [{ s: 's_a', r: 'rcp_superseded_attacker_pick' }],
  })
}

const PAGINATED_ROUTES = [
  { url: '/v2/reads/sessions/list', body: { limit: 10 }, op: 'ReadSessionsList' },
  { url: '/v2/reads/sessions/transcript', body: { sessionId: 'ses_any', limit: 10 }, op: 'ReadSessionsTranscript' },
  { url: '/v2/reads/search/query', body: { q: 'x', limit: 10 }, op: 'ReadSearchQuery' },
  { url: '/v2/reads/tool-calls/list', body: { limit: 10 }, op: 'ReadToolCallsList' },
] as const

describe('Lane 6 paginated-route cursor integrity (CQ-142 route evidence)', () => {
  for (const route of PAGINATED_ROUTES) {
    describe(route.url, () => {
      it('returns 400 / INVALID_CURSOR for an empty-string cursor (not page-1 semantics)', async () => {
        const t = await buildTestApp()
        try {
          const account = await signupTenant(
            t,
            `cursor-empty-${route.op}@example.com`,
            'Acme',
            `acme-${route.op}-empty`,
          )
          const response = await t.app.inject({
            method: 'POST',
            url: route.url,
            headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
            payload: { ...route.body, cursor: '' } as never,
          })
          expect(response.statusCode).toBe(400)
          const body = response.json() as { code: string; op: string }
          expect(body.code).toBe('INVALID_CURSOR')
          expect(body.op).toBe(route.op)
        } finally {
          await t.close()
        }
      })

      it('returns 400 / INVALID_CURSOR for a tampered cursor string', async () => {
        const t = await buildTestApp()
        try {
          const account = await signupTenant(
            t,
            `cursor-tamper-${route.op}@example.com`,
            'Acme',
            `acme-${route.op}-tamper`,
          )
          const response = await t.app.inject({
            method: 'POST',
            url: route.url,
            headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
            payload: { ...route.body, cursor: '!!!totally-not-a-cursor!!!' } as never,
          })
          expect(response.statusCode).toBe(400)
          expect((response.json() as { code: string }).code).toBe('INVALID_CURSOR')
        } finally {
          await t.close()
        }
      })

      it('returns 400 / INVALID_CURSOR for a wrong-signed (forged) cursor naming a superseded receipt', async () => {
        const t = await buildTestApp()
        try {
          const account = await signupTenant(
            t,
            `cursor-forged-${route.op}@example.com`,
            'Acme',
            `acme-${route.op}-forged`,
          )
          const response = await t.app.inject({
            method: 'POST',
            url: route.url,
            headers: { authorization: `Bearer ${account.token}`, 'content-type': 'application/json' },
            payload: { ...route.body, cursor: foreignCursor() } as never,
          })
          expect(response.statusCode).toBe(400)
          expect((response.json() as { code: string }).code).toBe('INVALID_CURSOR')
        } finally {
          await t.close()
        }
      })
    })
  }
})
