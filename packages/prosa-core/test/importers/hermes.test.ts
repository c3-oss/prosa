import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { compileHermes } from '../../src/importers/hermes/index.js'
import { exportSessionMarkdown } from '../../src/services/export/markdown.js'
import { searchFullText } from '../../src/services/search.js'
import { listSessions } from '../../src/services/sessions.js'
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js'

describe('hermes importer', () => {
  it('compiles SQLite sessions with tool calls and JSON/JSONL fallbacks', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeHermesFixture(t.path)
      const result = await compileHermes(t.bundle, sessionsDir)

      expect(result.counts.source_files_seen).toBe(3)
      expect(result.counts.source_files_imported).toBe(3)
      expect(result.counts.sessions).toBe(3)
      expect(result.counts.tool_calls).toBe(1)
      expect(result.counts.tool_results).toBe(1)

      const sessions = listSessions(t.bundle, { sourceTool: 'hermes' })
      expect(sessions).toHaveLength(3)
      expect(sessions.map((s) => s.source_session_id).sort()).toEqual(['db-main', 'legacy-jsonl', 'snapshot-only'])
      const dbMain = sessions.find((s) => s.source_session_id === 'db-main')!
      expect(
        t.bundle.db
          .prepare<[string], { status: string; tool_error_count: number }>(
            `SELECT status, tool_error_count FROM session_facts WHERE session_id = ?`,
          )
          .get(dbMain.session_id),
      ).toEqual({ status: 'completed', tool_error_count: 0 })
      expect(
        t.bundle.db
          .prepare<[string], { status: string }>(`SELECT status FROM tool_calls WHERE session_id = ?`)
          .get(dbMain.session_id)?.status,
      ).toBe('success')

      const md = await exportSessionMarkdown(t.bundle, dbMain.session_id)
      expect(md).toMatch(/Run build/)
      expect(md).toMatch(/tool: shell/)
      expect(md).not.toMatch(/private chain/)
    } finally {
      await t.cleanup()
    }
  })

  it('uses JSONL when it has more messages than SQLite and keeps hidden reasoning out of search', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeHermesFixture(t.path)
      await compileHermes(t.bundle, sessionsDir)

      const legacy = listSessions(t.bundle, { sourceTool: 'hermes' }).find(
        (s) => s.source_session_id === 'legacy-jsonl',
      )
      expect(legacy).toBeDefined()
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages WHERE session_id = ?`, legacy!.session_id),
      ).toBe(3)

      expect(searchFullText(t.bundle, { query: 'jsonl-only' }).length).toBeGreaterThan(0)
      expect(searchFullText(t.bundle, { query: 'private chain' })).toEqual([])
      expect(
        t.bundle.db
          .prepare<[string], { parser_status: string; json_pointer: string; record_kind: string }>(
            `SELECT parser_status, json_pointer, record_kind
               FROM raw_records
              WHERE source_tool = 'hermes' AND native_id = ? AND parser_status = 'partial'`,
          )
          .get('legacy-jsonl'),
      ).toEqual({
        parser_status: 'partial',
        json_pointer: '$.sessions.legacy-jsonl',
        record_kind: 'sqlite_row',
      })
    } finally {
      await t.cleanup()
    }
  })

  it('continues importing healthy Hermes sources when one transcript is malformed', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeHermesFixture(t.path)
      await writeFile(path.join(sessionsDir, 'bad.jsonl'), '{"role":"user","content":"unterminated"\n', 'utf8')

      const result = await compileHermes(t.bundle, sessionsDir)

      expect(result.counts.errors).toBe(1)
      expect(result.counts.sessions).toBe(3)
      expect(listSessions(t.bundle, { sourceTool: 'hermes' })).toHaveLength(3)
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM import_errors WHERE kind = ?`, 'hermes_file_failed'),
      ).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('detects Hermes tool errors from result content', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeJsonlOnlyFixture(t.path, 'tool-error', [
        { role: 'user', content: 'run failing command', timestamp: 1_778_804_720 },
        {
          role: 'assistant',
          content: 'calling shell',
          timestamp: 1_778_804_721,
          finish_reason: 'tool_calls',
          tool_calls: [{ id: 'call-error', function: { name: 'shell', arguments: '{"command":"false"}' } }],
        },
        {
          role: 'tool',
          content: 'Error: command failed',
          timestamp: 1_778_804_722,
          tool_call_id: 'call-error',
          tool_name: 'shell',
        },
      ])

      await compileHermes(t.bundle, sessionsDir)

      expect(
        t.bundle.db.prepare<[], { status: string; is_error: 0 | 1 }>(`SELECT status, is_error FROM tool_results`).get(),
      ).toEqual({
        status: 'error',
        is_error: 1,
      })
      expect(t.bundle.db.prepare<[], { status: string }>(`SELECT status FROM tool_calls`).get()?.status).toBe('error')
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM error_facts WHERE error_category = 'tool_result'`),
      ).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('marks Hermes sessions with parents as subagents', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeParentHermesFixture(t.path)
      await compileHermes(t.bundle, sessionsDir)

      const child = t.bundle.db
        .prepare<[], { parent_session_id: string; is_subagent: 0 | 1 }>(
          `SELECT parent_session_id, is_subagent FROM sessions WHERE source_session_id = 'child'`,
        )
        .get()
      const parent = t.bundle.db
        .prepare<[], { session_id: string }>(`SELECT session_id FROM sessions WHERE source_session_id = 'parent'`)
        .get()
      expect(child).toEqual({ parent_session_id: parent?.session_id, is_subagent: 1 })
    } finally {
      await t.cleanup()
    }
  })

  it('is idempotent', async () => {
    const t = await createTempBundle()
    try {
      const sessionsDir = await makeHermesFixture(t.path)
      const r1 = await compileHermes(t.bundle, sessionsDir)
      expect(r1.counts.source_files_imported).toBe(3)

      const r2 = await compileHermes(t.bundle, sessionsDir)
      expect(r2.counts.source_files_imported).toBe(0)
      expect(r2.counts.source_files_skipped).toBe(3)
      expect(r2.counts.sessions).toBe(0)
    } finally {
      await t.cleanup()
    }
  })
})

async function makeHermesFixture(root: string): Promise<string> {
  const hermesHome = path.join(root, 'hermes-home')
  const sessionsDir = path.join(hermesHome, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await makeStateDb(path.join(hermesHome, 'state.db'))

  await writeFile(
    path.join(sessionsDir, 'legacy-jsonl.jsonl'),
    [
      JSON.stringify({ role: 'user', content: 'from jsonl-one', timestamp: 1_778_804_710 }),
      JSON.stringify({ role: 'assistant', content: 'jsonl-only answer', timestamp: 1_778_804_711 }),
      JSON.stringify({ role: 'user', content: 'jsonl-only followup', timestamp: 1_778_804_712 }),
      '',
    ].join('\n'),
    'utf8',
  )

  await writeFile(
    path.join(sessionsDir, 'session_snapshot-only.json'),
    `${JSON.stringify(
      {
        session_id: 'snapshot-only',
        session_start: '2026-05-15T00:40:00.000Z',
        last_updated: '2026-05-15T00:41:00.000Z',
        platform: 'cli',
        model: 'hermes-model',
        system_prompt: 'snapshot system',
        messages: [
          { role: 'user', content: 'snapshot prompt', timestamp: '2026-05-15T00:40:00.000Z' },
          { role: 'assistant', content: 'snapshot answer', timestamp: '2026-05-15T00:41:00.000Z' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return sessionsDir
}

async function makeJsonlOnlyFixture(
  root: string,
  sourceSessionId: string,
  messages: Array<Record<string, unknown>>,
): Promise<string> {
  const sessionsDir = path.join(root, 'hermes-jsonl', 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    path.join(sessionsDir, `${sourceSessionId}.jsonl`),
    `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    'utf8',
  )
  return sessionsDir
}

async function makeParentHermesFixture(root: string): Promise<string> {
  const hermesHome = path.join(root, 'hermes-parent')
  const sessionsDir = path.join(hermesHome, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const db = new Database(path.join(hermesHome, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      title TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      codex_message_items TEXT
    );
  `)
  const insertSession = db.prepare(
    `INSERT INTO sessions (
       id, source, model, parent_session_id, started_at, ended_at, end_reason, message_count, title
     ) VALUES (?, 'cli', 'hermes-model', ?, ?, ?, 'stop', 1, ?)`,
  )
  insertSession.run('parent', null, 1_778_804_730, 1_778_804_731, 'Parent')
  insertSession.run('child', 'parent', 1_778_804_732, 1_778_804_733, 'Child')
  const insertMessage = db.prepare(
    `INSERT INTO messages (
       session_id, role, content, timestamp, token_count, finish_reason
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  insertMessage.run('parent', 'user', 'parent prompt', 1_778_804_730, 1, null)
  insertMessage.run('child', 'user', 'child prompt', 1_778_804_732, 1, null)
  db.close()
  return sessionsDir
}

async function makeStateDb(dbPath: string): Promise<void> {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      model_config TEXT,
      system_prompt TEXT,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      billing_provider TEXT,
      billing_base_url TEXT,
      billing_mode TEXT,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      cost_status TEXT,
      cost_source TEXT,
      pricing_version TEXT,
      title TEXT,
      api_call_count INTEGER DEFAULT 0,
      handoff_state TEXT,
      handoff_platform TEXT,
      handoff_error TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL,
      token_count INTEGER,
      finish_reason TEXT,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      codex_reasoning_items TEXT,
      codex_message_items TEXT
    );
  `)

  db.prepare(
    `INSERT INTO sessions (
       id, source, model, system_prompt, started_at, ended_at, end_reason,
       message_count, tool_call_count, title
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('db-main', 'cli', 'hermes-model', 'system prompt', 1_778_804_700, 1_778_804_704, 'stop', 4, 1, 'DB main')
  db.prepare(
    `INSERT INTO sessions (
       id, source, model, started_at, ended_at, end_reason, message_count, title
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('legacy-jsonl', 'telegram', 'hermes-model', 1_778_804_710, 1_778_804_711, 'stop', 1, 'Legacy')

  const insertMessage = db.prepare(
    `INSERT INTO messages (
       session_id, role, content, tool_call_id, tool_calls, tool_name,
       timestamp, token_count, finish_reason, reasoning
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertMessage.run('db-main', 'user', 'Run build', null, null, null, 1_778_804_700, 3, null, null)
  insertMessage.run(
    'db-main',
    'assistant',
    'Calling shell',
    null,
    JSON.stringify([
      { id: 'call-1', function: { name: 'shell', arguments: JSON.stringify({ command: 'pnpm test' }) } },
    ]),
    null,
    1_778_804_701,
    4,
    'tool_calls',
    null,
  )
  insertMessage.run('db-main', 'tool', 'tests passed', 'call-1', null, 'shell', 1_778_804_702, 2, null, null)
  insertMessage.run('db-main', 'assistant', 'Done', null, null, null, 1_778_804_703, 1, 'stop', 'private chain')
  insertMessage.run('legacy-jsonl', 'user', 'db-only legacy', null, null, null, 1_778_804_710, 1, null, null)
  db.close()
}
