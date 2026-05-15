import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type SignupResult = { token: string; tenant: { id: string }; user: { id: string } }

async function signup(t: TestApp, email: string): Promise<SignupResult> {
  const slug = email.replaceAll(/[^a-z0-9]/g, '-')
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: email,
      tenantSlug: slug,
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { result: { data: SignupResult } }).result.data
}

async function trpc(t: TestApp, path: string, input: unknown, token: string, method: 'GET' | 'POST' = 'POST') {
  if (method === 'GET') {
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: input as never,
  })
}

async function seedVerifiedSession(t: TestApp, auth: SignupResult): Promise<void> {
  // Bring up a sync batch, commit a session, then verify it. This is the
  // only path that exposes data through the verified-projection gate the
  // read API uses.
  const handshake = await trpc(
    t,
    'sync.handshake',
    {
      cliVersion: '0.0.0',
      device: { name: 'device-reads', platform: 'linux' },
      store: { path: '/tmp/.prosa-reads', bundleVersion: '1' },
    },
    auth.token,
  )
  const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
  const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/.prosa-reads', objects: [] }, auth.token)
  const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

  await trpc(
    t,
    'sync.commitUpload',
    {
      batchId,
      deviceId,
      storePath: '/tmp/.prosa-reads',
      objects: [],
      projection: {
        sessions: [
          {
            id: 'sess-codex-1',
            sourceKind: 'codex',
            title: 'compile bundle',
            turnCount: 3,
            startedAt: '2026-04-01T10:00:00Z',
            endedAt: '2026-04-01T10:05:00Z',
          },
          {
            id: 'sess-claude-1',
            sourceKind: 'claude',
            title: 'plan timeline',
            turnCount: 6,
            startedAt: '2026-04-02T12:00:00Z',
          },
        ],
        searchDocs: [
          {
            id: 'doc-codex-1',
            sessionId: 'sess-codex-1',
            kind: 'message',
            body: 'discussing bundle compilation with widgets and timestamps',
          },
          {
            id: 'doc-claude-1',
            sessionId: 'sess-claude-1',
            kind: 'message',
            body: 'plan timeline panel structure for the console',
          },
        ],
      },
    },
    auth.token,
  )

  const verifyResp = await trpc(
    t,
    'sync.verifyPromotion',
    {
      batchId,
      storePath: '/tmp/.prosa-reads',
      declaredSessionIds: ['sess-codex-1', 'sess-claude-1'],
      declaredSearchDocIds: ['doc-codex-1', 'doc-claude-1'],
    },
    auth.token,
  )
  expect(verifyResp.statusCode).toBe(200)

  // Seed the auxiliary projection rows directly. The sync commit surface
  // currently only upserts sessions + searchDocs (sourceFiles/rawRecords);
  // tool calls, results, messages, and events arrive through a future
  // expansion of the commit shape. The verified-manifest gate is already
  // satisfied by the session rows above, so reads still respect it.
  const tenantId = auth.tenant.id
  await t.pglite.query(
    `INSERT INTO "projection_tool_call"(tenant_id, id, session_id, turn_id, name, status, input_object_id, created_at)
       VALUES
         ($1, 'tc-1', 'sess-codex-1', NULL, 'shell.exec', 'ok', NULL, '2026-04-01T10:01:00Z'),
         ($1, 'tc-2', 'sess-codex-1', NULL, 'fs.write', 'error', NULL, '2026-04-01T10:02:00Z')`,
    [tenantId],
  )
  await t.pglite.query(
    `INSERT INTO "projection_tool_result"(tenant_id, id, tool_call_id, output_object_id, status, finished_at)
       VALUES
         ($1, 'tr-1', 'tc-1', NULL, 'ok', '2026-04-01T10:01:30Z'),
         ($1, 'tr-2', 'tc-2', NULL, 'error', '2026-04-01T10:02:10Z')`,
    [tenantId],
  )
  await t.pglite.query(
    `INSERT INTO "projection_message"(tenant_id, id, session_id, turn_id, role, model, created_at)
       VALUES
         ($1, 'msg-1', 'sess-codex-1', NULL, 'user', 'gpt-5', '2026-04-01T10:00:30Z'),
         ($1, 'msg-2', 'sess-codex-1', NULL, 'assistant', 'gpt-5', '2026-04-01T10:00:45Z')`,
    [tenantId],
  )
  await t.pglite.query(
    `INSERT INTO "projection_event"(tenant_id, id, session_id, turn_id, sequence, kind, payload, occurred_at)
       VALUES
         ($1, 'ev-1', 'sess-codex-1', NULL, 0, 'message', '{"messageId":"msg-1"}'::jsonb, '2026-04-01T10:00:30Z'),
         ($1, 'ev-2', 'sess-codex-1', NULL, 1, 'toolCall', '{"toolCallId":"tc-1"}'::jsonb, '2026-04-01T10:01:00Z')`,
    [tenantId],
  )
}

describe('Read API v0', () => {
  it('sessions.list returns cursor-paginated rows scoped to verified projection data', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-a@example.com')
      await seedVerifiedSession(t, auth)

      const all = await trpc(t, 'sessions.list', { limit: 50 }, auth.token, 'GET')
      expect(all.statusCode).toBe(200)
      const data = (
        all.json() as {
          result: {
            data: {
              rows: Array<{
                id: string
                sourceKind: string
                messageCount: number
                toolCallCount: number
                errorCount: number
              }>
              nextCursor: string | null
            }
          }
        }
      ).result.data
      expect(data.rows.map((r) => r.id).sort()).toEqual(['sess-claude-1', 'sess-codex-1'])
      expect(data.nextCursor).toBeNull()

      const codexRow = data.rows.find((r) => r.id === 'sess-codex-1')
      // CQ-004: aggregate auxiliary counts are always 0 in v0 because the
      // auxiliary projection tables have no row-level verified provenance.
      expect(codexRow?.messageCount).toBe(0)
      expect(codexRow?.toolCallCount).toBe(0)
      expect(codexRow?.errorCount).toBe(0)

      // Cursor pagination: limit=1 yields a cursor, second page completes the set.
      const page1 = await trpc(t, 'sessions.list', { limit: 1 }, auth.token, 'GET')
      const page1Data = (
        page1.json() as {
          result: { data: { rows: Array<{ id: string }>; nextCursor: string | null } }
        }
      ).result.data
      expect(page1Data.rows).toHaveLength(1)
      expect(page1Data.nextCursor).not.toBeNull()
      const page2 = await trpc(
        t,
        'sessions.list',
        { limit: 1, cursor: page1Data.nextCursor as string },
        auth.token,
        'GET',
      )
      const page2Data = (
        page2.json() as {
          result: { data: { rows: Array<{ id: string }>; nextCursor: string | null } }
        }
      ).result.data
      expect(page2Data.rows).toHaveLength(1)
      expect(new Set([page1Data.rows[0]?.id, page2Data.rows[0]?.id])).toEqual(
        new Set(['sess-claude-1', 'sess-codex-1']),
      )

      // Source filter.
      const filtered = await trpc(t, 'sessions.list', { sourceKinds: ['codex'] }, auth.token, 'GET')
      const filteredData = (filtered.json() as { result: { data: { rows: Array<{ id: string }> } } }).result.data
      expect(filteredData.rows.map((r) => r.id)).toEqual(['sess-codex-1'])
    } finally {
      await t.close()
    }
  })

  it('sessions.detail returns the session with fail-closed empty auxiliary rows (CQ-004)', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-b@example.com')
      await seedVerifiedSession(t, auth)

      const detail = await trpc(t, 'sessions.detail', { sessionId: 'sess-codex-1' }, auth.token, 'GET')
      expect(detail.statusCode).toBe(200)
      const data = (
        detail.json() as {
          result: {
            data: {
              session: { id: string }
              events: { rows: unknown[]; nextCursor: string | null }
              relatedArtifacts: unknown[]
              auxiliaryRowsAvailable: boolean
            }
          }
        }
      ).result.data
      expect(data.session.id).toBe('sess-codex-1')
      // Directly seeded auxiliary rows (events, artifacts) must NOT surface
      // because they have no row-level verified manifest entry.
      expect(data.events.rows).toEqual([])
      expect(data.events.nextCursor).toBeNull()
      expect(data.relatedArtifacts).toEqual([])
      expect(data.auxiliaryRowsAvailable).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('toolCalls.list fails closed with an empty page (CQ-004)', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-tc@example.com')
      await seedVerifiedSession(t, auth)

      const calls = await trpc(t, 'toolCalls.list', { limit: 50 }, auth.token, 'GET')
      expect(calls.statusCode).toBe(200)
      const data = (
        calls.json() as {
          result: {
            data: { rows: unknown[]; nextCursor: string | null; verifiedAuxiliaryAvailable: boolean }
          }
        }
      ).result.data
      expect(data.rows).toEqual([])
      expect(data.nextCursor).toBeNull()
      expect(data.verifiedAuxiliaryAvailable).toBe(false)

      // Unsupported filters still fail with BAD_REQUEST (CQ-005).
      const bad = await trpc(t, 'toolCalls.list', { canonicalToolTypes: ['shell'] }, auth.token, 'GET')
      expect(bad.statusCode).toBe(400)
    } finally {
      await t.close()
    }
  })

  it('analytics.report fails closed for every report kind in v0 (CQ-004/CQ-006)', async () => {
    // The remote projection lacks the verified auxiliary manifest entries
    // required for parity with the prosa analytics CLI surface (and the
    // `project` table is not in the manifest). Rather than emit a reduced
    // shape that drifts from the CLI/local contract, every remote report
    // fails closed with 501.
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-ana@example.com')
      await seedVerifiedSession(t, auth)

      for (const report of ['sessions', 'tools', 'errors', 'models', 'projects'] as const) {
        const resp = await trpc(t, 'analytics.report', { report }, auth.token, 'GET')
        expect(resp.statusCode).toBe(501)
      }
    } finally {
      await t.close()
    }
  })

  it('sessions.list/count reject auxiliary-row filters that have no verified manifest (CQ-004)', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-aux-filters@example.com')
      await seedVerifiedSession(t, auth)

      for (const procedure of ['sessions.list', 'sessions.count'] as const) {
        const withModel = await trpc(t, procedure, { model: 'gpt-5' }, auth.token, 'GET')
        expect(withModel.statusCode).toBe(400)
        const withHasErrors = await trpc(t, procedure, { hasErrors: true }, auth.token, 'GET')
        expect(withHasErrors.statusCode).toBe(400)
      }
    } finally {
      await t.close()
    }
  })

  it('artifacts.getText refuses unknown artifacts', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-art@example.com')
      await seedVerifiedSession(t, auth)

      const missing = await trpc(t, 'artifacts.getText', { artifactId: 'nope' }, auth.token, 'GET')
      expect(missing.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('search.query fails closed in remote v0 (CQ-005)', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-s@example.com')
      await seedVerifiedSession(t, auth)

      const resp = await trpc(t, 'search.query', { q: 'widgets' }, auth.token, 'GET')
      expect(resp.statusCode).toBe(501)
    } finally {
      await t.close()
    }
  })
})
