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
        toolCalls: [
          {
            id: 'tc-error',
            sessionId: 'sess-codex-1',
            name: 'fs.write',
            status: 'error',
            createdAt: '2026-04-01T10:02:00.000Z',
          },
          {
            id: 'tc-success',
            sessionId: 'sess-claude-1',
            name: 'shell.exec',
            status: 'success',
            createdAt: '2026-04-02T12:01:00.000Z',
          },
        ],
        toolResults: [
          {
            id: 'tr-error',
            toolCallId: 'tc-error',
            status: 'error',
            finishedAt: '2026-04-01T10:02:10.000Z',
          },
          {
            id: 'tr-success-old-error',
            toolCallId: 'tc-success',
            status: 'error',
            finishedAt: '2026-04-02T12:01:05.000Z',
          },
          {
            id: 'tr-success',
            toolCallId: 'tc-success',
            status: 'success',
            finishedAt: '2026-04-02T12:01:30.000Z',
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
      declaredToolCallIds: ['tc-error', 'tc-success'],
      declaredToolResultIds: ['tr-error', 'tr-success-old-error', 'tr-success'],
    },
    auth.token,
  )
  expect(verifyResp.statusCode).toBe(200)

  // Seed only auxiliary rows that still have no sync projection manifest.
  // Tool calls/results above arrive through commitUpload and are verified
  // row-by-row before reads can expose them.
  const tenantId = auth.tenant.id
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
         ($1, 'ev-2', 'sess-codex-1', NULL, 1, 'toolCall', '{"toolCallId":"tc-error"}'::jsonb, '2026-04-01T10:01:00Z')`,
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
      // Tool calls/results now have verified manifest entries; messages still
      // fail closed until their projection rows are promoted and verified.
      expect(codexRow?.messageCount).toBe(0)
      expect(codexRow?.toolCallCount).toBe(1)
      expect(codexRow?.errorCount).toBe(1)

      const claudeRow = data.rows.find((r) => r.id === 'sess-claude-1')
      expect(claudeRow?.toolCallCount).toBe(1)
      expect(claudeRow?.errorCount).toBe(0)

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

  it('toolCalls.list returns tool calls attached to verified sessions', async () => {
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
                sessionId: string
                sessionTitle: string | null
                sourceKind: string
                name: string
                status: string | null
                resultStatus: string | null
                durationMs: number | null
              }>
              nextCursor: string | null
              verifiedAuxiliaryAvailable: boolean
            }
          }
        }
      ).result.data
      expect(data.rows.map((row) => row.id)).toEqual(['tc-success', 'tc-error'])
      expect(data.rows[1]).toMatchObject({
        id: 'tc-error',
        sessionId: 'sess-codex-1',
        sessionTitle: 'compile bundle',
        sourceKind: 'codex',
        name: 'fs.write',
        status: 'error',
        resultStatus: 'error',
        durationMs: 10000,
      })
      expect(data.nextCursor).toBeNull()
      expect(data.verifiedAuxiliaryAvailable).toBe(true)

      const errorsOnly = await trpc(t, 'toolCalls.list', { limit: 50, errorsOnly: true }, auth.token, 'GET')
      expect(errorsOnly.statusCode).toBe(200)
      const errorsOnlyData = (
        errorsOnly.json() as {
          result: { data: { rows: Array<{ id: string }> } }
        }
      ).result.data
      expect(errorsOnlyData.rows.map((row) => row.id)).toEqual(['tc-error'])

      // Unsupported filters still fail with BAD_REQUEST (CQ-005).
      const bad = await trpc(t, 'toolCalls.list', { canonicalToolTypes: ['shell'] }, auth.token, 'GET')
      expect(bad.statusCode).toBe(400)
    } finally {
      await t.close()
    }
  })

  it('analytics.report returns remote-authoritative reports from verified projection data', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-ana@example.com')
      await seedVerifiedSession(t, auth)

      const sessions = await trpc(t, 'analytics.report', { report: 'sessions' }, auth.token, 'GET')
      expect(sessions.statusCode).toBe(200)
      const sessionsData = (
        sessions.json() as {
          result: {
            data: {
              report: 'sessions'
              rows: Array<{ session_id: string; source_tool: string; title: string | null }>
              generatedAt: string
            }
          }
        }
      ).result.data
      expect(sessionsData.report).toBe('sessions')
      expect(sessionsData.rows.map((row) => row.session_id).sort()).toEqual(['sess-claude-1', 'sess-codex-1'])
      expect(sessionsData.rows.find((row) => row.session_id === 'sess-codex-1')).toMatchObject({
        source_tool: 'codex',
        title: 'compile bundle',
      })
      expect(new Date(sessionsData.generatedAt).toString()).not.toBe('Invalid Date')

      const projects = await trpc(t, 'analytics.report', { report: 'projects' }, auth.token, 'GET')
      expect(projects.statusCode).toBe(200)
      const projectsData = (
        projects.json() as {
          result: { data: { report: 'projects'; rows: Array<{ source_tool: string; session_count: number }> } }
        }
      ).result.data
      expect(projectsData.report).toBe('projects')
      expect(projectsData.rows.map((row) => [row.source_tool, row.session_count])).toEqual([
        ['claude', 1],
        ['codex', 1],
      ])

      for (const report of ['tools', 'errors', 'models'] as const) {
        const resp = await trpc(t, 'analytics.report', { report }, auth.token, 'GET')
        expect(resp.statusCode).toBe(200)
        const data = (resp.json() as { result: { data: { report: typeof report; rows: unknown[] } } }).result.data
        expect(data.report).toBe(report)
        expect(data.rows).toEqual([])
      }
    } finally {
      await t.close()
    }
  })

  it('sessions.list/count reject message filters and support verified tool error filters', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-aux-filters@example.com')
      await seedVerifiedSession(t, auth)

      for (const procedure of ['sessions.list', 'sessions.count'] as const) {
        const withModel = await trpc(t, procedure, { model: 'gpt-5' }, auth.token, 'GET')
        expect(withModel.statusCode).toBe(400)
        const withHasErrors = await trpc(t, procedure, { hasErrors: true }, auth.token, 'GET')
        expect(withHasErrors.statusCode).toBe(200)
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

  it('search.query returns verified search_doc matches', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'reads-s@example.com')
      await seedVerifiedSession(t, auth)

      const resp = await trpc(t, 'search.query', { q: 'widgets' }, auth.token, 'GET')
      expect(resp.statusCode).toBe(200)
      const data = (
        resp.json() as {
          result: {
            data: {
              rows: Array<{ id: string; sessionId: string; sessionTitle: string | null; snippet: string }>
              nextCursor: string | null
            }
          }
        }
      ).result.data
      expect(data.rows).toHaveLength(1)
      expect(data.rows[0]).toMatchObject({
        id: 'doc-codex-1',
        sessionId: 'sess-codex-1',
        sessionTitle: 'compile bundle',
      })
      expect(data.rows[0]?.snippet).toContain('widgets')
      expect(data.nextCursor).toBeNull()
    } finally {
      await t.close()
    }
  })
})
