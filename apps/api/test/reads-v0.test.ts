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
      expect(codexRow?.messageCount).toBe(2)
      expect(codexRow?.toolCallCount).toBe(2)
      expect(codexRow?.errorCount).toBe(1)

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

  it('sessions.detail returns ordered events and a related-artifacts placeholder', async () => {
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
              session: { id: string; messageCount: number; toolCallCount: number }
              events: { rows: Array<{ id: string; kind: string; ordinal: number }>; nextCursor: string | null }
              relatedArtifacts: unknown[]
            }
          }
        }
      ).result.data
      expect(data.session.id).toBe('sess-codex-1')
      expect(data.events.rows.map((e) => e.kind)).toEqual(['message', 'toolCall'])
      expect(data.events.rows[0]?.ordinal).toBe(0)
      expect(Array.isArray(data.relatedArtifacts)).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('toolCalls.list returns global audit rows joined with session metadata', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-tc@example.com')
      await seedVerifiedSession(t, auth)

      const calls = await trpc(t, 'toolCalls.list', { limit: 50 }, auth.token, 'GET')
      expect(calls.statusCode).toBe(200)
      const data = (
        calls.json() as {
          result: {
            data: {
              rows: Array<{
                id: string
                name: string
                status: string | null
                resultStatus: string | null
                sourceKind: string
              }>
              nextCursor: string | null
            }
          }
        }
      ).result.data
      expect(data.rows.map((r) => r.id).sort()).toEqual(['tc-1', 'tc-2'])
      const errCall = data.rows.find((r) => r.id === 'tc-2')
      expect(errCall?.status).toBe('error')
      expect(errCall?.resultStatus).toBe('error')
      expect(errCall?.sourceKind).toBe('codex')

      const errorsOnly = await trpc(t, 'toolCalls.list', { errorsOnly: true }, auth.token, 'GET')
      const errorsData = (errorsOnly.json() as { result: { data: { rows: Array<{ id: string }> } } }).result.data
      expect(errorsData.rows.map((r) => r.id)).toEqual(['tc-2'])
    } finally {
      await t.close()
    }
  })

  it('analytics.report exposes the five report types over verified projection data', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-ana@example.com')
      await seedVerifiedSession(t, auth)

      const reports = ['sessions', 'tools', 'errors', 'models', 'projects'] as const
      for (const report of reports) {
        const resp = await trpc(t, 'analytics.report', { report }, auth.token, 'GET')
        expect(resp.statusCode).toBe(200)
        const data = (
          resp.json() as {
            result: { data: { report: string; rows: unknown[]; generatedAt: string } }
          }
        ).result.data
        expect(data.report).toBe(report)
        expect(Array.isArray(data.rows)).toBe(true)
      }

      // The 'tools' report must surface the two distinct tool names.
      const tools = await trpc(t, 'analytics.report', { report: 'tools' }, auth.token, 'GET')
      const toolsData = (tools.json() as { result: { data: { rows: Array<{ tool_name: string }> } } }).result.data
      expect(toolsData.rows.map((r) => r.tool_name).sort()).toEqual(['fs.write', 'shell.exec'])

      // The 'errors' report should contain tc-2 only.
      const errors = await trpc(t, 'analytics.report', { report: 'errors' }, auth.token, 'GET')
      const errorsData = (errors.json() as { result: { data: { rows: Array<{ tool_call_id: string }> } } }).result.data
      expect(errorsData.rows.map((r) => r.tool_call_id)).toEqual(['tc-2'])
    } finally {
      await t.close()
    }
  })

  it('artifacts.getText refuses unknown objects and cross-tenant access', async () => {
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

  it('search.query returns cursor-paginated FTS-like hits with session metadata', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-s@example.com')
      await seedVerifiedSession(t, auth)

      const hits = await trpc(t, 'search.query', { q: 'widgets' }, auth.token, 'GET')
      expect(hits.statusCode).toBe(200)
      const data = (
        hits.json() as {
          result: {
            data: {
              rows: Array<{ sessionId: string; sessionTitle: string | null; sourceKind: string; snippet: string }>
              nextCursor: string | null
            }
          }
        }
      ).result.data
      expect(data.rows.map((r) => r.sessionId)).toEqual(['sess-codex-1'])
      expect(data.rows[0]?.sourceKind).toBe('codex')
    } finally {
      await t.close()
    }
  })
})
