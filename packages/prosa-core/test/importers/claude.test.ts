import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerSourceFile } from '../../src/core/ingest/idempotency.js'
import { compileClaude } from '../../src/importers/claude/index.js'
import { exportSessionMarkdown } from '../../src/services/export/markdown.js'
import { searchFullText } from '../../src/services/search.js'
import { getSession, listSessions } from '../../src/services/sessions.js'
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES = path.resolve(__dirname, '../fixtures/claude')

if (!existsSync(FIXTURES)) {
  throw new Error(`fixtures missing at ${FIXTURES}`)
}

describe('claude importer', () => {
  it('compiles main session and subagent', async () => {
    const t = await createTempBundle()
    try {
      const result = await compileClaude(t.bundle, FIXTURES)
      expect(result.counts.source_files_seen).toBe(2)
      expect(result.counts.source_files_imported).toBe(2)
      expect(result.counts.sessions).toBe(2)
      // 5 user/assistant in main (u1, u2, u3, u4, u6) + 3 in subagent = 8.
      expect(result.counts.messages).toBe(8)
      // 2 tool_use in main + 1 in subagent
      expect(result.counts.tool_calls).toBe(3)
      // 1 tool_result in main + 1 in subagent
      expect(result.counts.tool_results).toBe(2)

      const sessions = listSessions(t.bundle, { sourceTool: 'claude' })
      expect(sessions).toHaveLength(2)

      const sub = sessions.find((s) => s.is_subagent === 1)
      expect(sub).toBeDefined()
      expect(sub?.parent_session_id).not.toBeNull()
      const parent = sessions.find((s) => s.session_id === sub?.parent_session_id)
      expect(parent).toBeDefined()
      expect(parent?.is_subagent).toBe(0)
    } finally {
      await t.cleanup()
    }
  })

  it('does not treat type="system" as a system_prompt message', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages WHERE role = 'system_prompt'`)).toBe(0)

      expect(
        queryCount(
          t.bundle.db,
          `SELECT count(*) AS n FROM events WHERE event_type = 'system_operational' AND source_type = 'system'`,
        ),
      ).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })

  it('matches tool_use to tool_result via tool_use_id', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      expect(
        queryCount(
          t.bundle.db,
          `SELECT count(*) AS n
             FROM tool_results tr
            WHERE tr.tool_call_id IS NULL
              AND tr.source_call_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.source_call_id = tr.source_call_id)`,
        ),
      ).toBe(0)
    } finally {
      await t.cleanup()
    }
  })

  it('records parent_of edges for chained messages', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM edges WHERE edge_type = 'parent_of'`)).toBeGreaterThan(
        0,
      )
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages WHERE parent_message_id IS NOT NULL`)).toBe(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM edges WHERE edge_type = 'parent_of'`),
      )
    } finally {
      await t.cleanup()
    }
  })

  it('links sourceToolAssistantUUID from subagent session back to parent message', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)

      const edge = t.bundle.db
        .prepare<[], { source: string; parent_uuid: string | null; child_is_subagent: 0 | 1 }>(
          `SELECT e.source, parent_raw.native_id AS parent_uuid, child.is_subagent AS child_is_subagent
             FROM edges e
             JOIN messages parent_msg ON parent_msg.message_id = e.src_id
             JOIN raw_records parent_raw ON parent_raw.raw_record_id = parent_msg.raw_record_id
             JOIN sessions child ON child.session_id = e.dst_id
            WHERE e.src_type = 'message'
              AND e.dst_type = 'session'
              AND e.edge_type = 'spawned'
              AND e.source = 'source_tool_assistant_uuid'`,
        )
        .get()
      expect(edge).toEqual({
        source: 'source_tool_assistant_uuid',
        parent_uuid: 'u6',
        child_is_subagent: 1,
      })
    } finally {
      await t.cleanup()
    }
  })

  it('is idempotent on re-import', async () => {
    const t = await createTempBundle()
    try {
      const r1 = await compileClaude(t.bundle, FIXTURES)
      expect(r1.counts.source_files_imported).toBe(2)
      const r2 = await compileClaude(t.bundle, FIXTURES)
      expect(r2.counts.source_files_imported).toBe(0)
      expect(r2.counts.source_files_skipped).toBe(2)
    } finally {
      await t.cleanup()
    }
  })

  it('imports a registered source file that has no raw records', async () => {
    const fixtureParent = await mkdtemp(path.join(os.tmpdir(), 'prosa-claude-fixture-'))
    const fixtureRoot = path.join(fixtureParent, 'claude')
    const t = await createTempBundle()

    try {
      await cp(FIXTURES, fixtureRoot, { recursive: true })
      const mainPath = path.join(fixtureRoot, '-Users-test-proj', 'abc12345-9999-aaaa-bbbb-cccccccccccc.jsonl')
      await registerSourceFile(t.bundle, {
        sourceTool: 'claude',
        absolutePath: mainPath,
        fileKind: 'jsonl',
        workspaceHint: '-Users-test-proj',
      })

      const result = await compileClaude(t.bundle, fixtureRoot)
      expect(result.counts.source_files_imported).toBe(2)
      expect(result.counts.source_files_skipped).toBe(0)
      expect(
        queryCount(
          t.bundle.db,
          `SELECT count(*) AS n
             FROM raw_records rr
             JOIN source_files sf ON sf.source_file_id = rr.source_file_id
            WHERE sf.path = ?`,
          path.resolve(mainPath),
        ),
      ).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
      await rm(fixtureParent, { recursive: true, force: true })
    }
  })

  it('dedupes sourceToolAssistantUUID edges when a subagent file changes', async () => {
    const fixtureParent = await mkdtemp(path.join(os.tmpdir(), 'prosa-claude-fixture-'))
    const fixtureRoot = path.join(fixtureParent, 'claude')
    const t = await createTempBundle()

    try {
      await cp(FIXTURES, fixtureRoot, { recursive: true })
      await compileClaude(t.bundle, fixtureRoot)

      const subagentPath = path.join(
        fixtureRoot,
        '-Users-test-proj',
        'abc12345-9999-aaaa-bbbb-cccccccccccc',
        'subagents',
        'agent-a54a24a7c3464205a.jsonl',
      )
      const text = await readFile(subagentPath, 'utf8')
      await writeFile(
        subagentPath,
        `${text.trimEnd()}\n${JSON.stringify({
          type: 'system',
          uuid: 'sa4',
          parentUuid: 'sa3',
          sessionId: 'abc12345-9999-aaaa-bbbb-cccccccccccc',
          isSidechain: true,
          agentId: 'a54a24a7c3464205a',
          timestamp: '2026-05-01T10:00:08.000Z',
          subtype: 'turn_duration',
          level: 'info',
          durationMs: 1000,
        })}\n`,
      )

      const second = await compileClaude(t.bundle, fixtureRoot)
      expect(second.counts.source_files_imported).toBe(1)
      expect(second.counts.source_files_skipped).toBe(1)

      const edges = t.bundle.db
        .prepare<[], { src_id: string; parent_uuid: string | null }>(
          `SELECT e.src_id, parent_raw.native_id AS parent_uuid
             FROM edges e
             LEFT JOIN messages parent_msg ON parent_msg.message_id = e.src_id
             LEFT JOIN raw_records parent_raw ON parent_raw.raw_record_id = parent_msg.raw_record_id
            WHERE e.src_type = 'message'
              AND e.dst_type = 'session'
              AND e.edge_type = 'spawned'
              AND e.source = 'source_tool_assistant_uuid'`,
        )
        .all()

      expect(edges).toHaveLength(1)
      expect(edges[0]?.parent_uuid).toBe('u6')
      expect(edges[0]?.src_id).not.toBe('u6')
    } finally {
      await t.cleanup()
      await rm(fixtureParent, { recursive: true, force: true })
    }
  })

  it('exports a session as markdown including the tool calls', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      const sessions = listSessions(t.bundle, { sourceTool: 'claude' })
      const main = sessions.find((s) => s.is_subagent === 0)
      const md = await exportSessionMarkdown(t.bundle, main!.session_id)
      expect(md).toMatch(/grep for TODO/)
      expect(md).toMatch(/tool: Bash/)
    } finally {
      await t.cleanup()
    }
  })

  it('finds matches via FTS5', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      const hits = searchFullText(t.bundle, { query: 'TODO' })
      expect(hits.length).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })

  it('returns timeline events for a session', async () => {
    const t = await createTempBundle()
    try {
      await compileClaude(t.bundle, FIXTURES)
      const sessions = listSessions(t.bundle, { sourceTool: 'claude' })
      const detail = getSession(t.bundle, sessions[0]!.session_id)
      expect(detail!.events.length).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })
})
