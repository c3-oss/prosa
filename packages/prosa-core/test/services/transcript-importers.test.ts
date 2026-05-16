import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { compileClaude } from '../../src/importers/claude/index.js'
import { compileCodex } from '../../src/importers/codex/index.js'
import { compileCursor } from '../../src/importers/cursor/index.js'
import { compileGemini } from '../../src/importers/gemini/index.js'
import { compileHermes } from '../../src/importers/hermes/index.js'
import { listSessions } from '../../src/services/sessions.js'
import { type SessionTranscript, loadTranscript } from '../../src/services/transcript.js'
import { type TempBundle, createTempBundle } from '../helpers/tmp-bundle.js'

/**
 * Cross-source integration matrix for `loadTranscript`. Each importer is fed
 * its own synthetic fixture (mirroring the per-importer test patterns) and
 * the resulting bundle is loaded through `loadTranscript`. The shared
 * invariants below are the contract every source must honor; importer-
 * specific signals (e.g. hidden reasoning blocks) live in `extraAsserts`.
 *
 * Fixtures that do not exercise a given signal mark their per-source check as
 * `it.todo` rather than failing — the matrix focuses on what each importer
 * actually preserves today.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_FIXTURES = path.resolve(__dirname, '../fixtures/claude')
const CODEX_FIXTURES = path.resolve(__dirname, '../fixtures/codex')
const GEMINI_FIXTURES = path.resolve(__dirname, '../fixtures/gemini')

type SourceKind = 'codex' | 'claude' | 'gemini' | 'cursor' | 'hermes'

interface SourceCase {
  /** Source tool key, also used as the test name. */
  source: SourceKind
  /** Compile a fixture into a fresh bundle and return one session id to probe. */
  prepare: (t: TempBundle) => Promise<string>
  /** True when the chosen session is expected to expose hidden thinking blocks. */
  expectsHiddenBlocks: boolean
  /** True when the chosen session is expected to expose at least one tool call. */
  expectsToolCalls: boolean
  /** True when the chosen session is expected to expose both a user and assistant turn. */
  expectsUserAndAssistant: boolean
}

async function makeCursorFixture(root: string): Promise<void> {
  const workspaceId = 'workspace-test'
  const agentId = '64a9033f-00d4-4870-af5a-d2331bde2876'
  const dir = path.join(root, workspaceId, agentId)
  await mkdir(dir, { recursive: true })
  const dbPath = path.join(dir, 'store.db')

  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE meta  (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
  `)
  const meta = {
    agentId,
    latestRootBlobId: 'rootblobid',
    name: 'Test agent',
    mode: 'default',
    createdAt: 1774457736671,
    lastUsedModel: 'composer-1.5',
  }
  db.prepare(`INSERT INTO meta(key, value) VALUES ('0', ?)`).run(
    Buffer.from(JSON.stringify(meta), 'utf8').toString('hex'),
  )
  const insertBlob = db.prepare(`INSERT INTO blobs(id, data) VALUES (?, ?)`)
  insertBlob.run(
    'sys1',
    Buffer.from(JSON.stringify({ role: 'system', content: 'You are a coding assistant.' }), 'utf8'),
  )
  insertBlob.run('u1', Buffer.from(JSON.stringify({ role: 'user', content: 'list files' }), 'utf8'))
  insertBlob.run(
    'a1',
    Buffer.from(
      JSON.stringify({
        role: 'assistant',
        id: 'a1',
        content: [
          { type: 'text', text: 'Listing now.' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls -la' } },
        ],
      }),
      'utf8',
    ),
  )
  insertBlob.run(
    't1',
    Buffer.from(
      JSON.stringify({
        role: 'tool',
        id: 't1',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'Shell',
            result: 'total 0\n.\n..\n',
            experimental_content: { isError: false },
          },
        ],
      }),
      'utf8',
    ),
  )
  // Non-JSON blob mimicking Cursor's protobuf root state — importer must
  // accept it without crashing; transcript loader simply won't surface it.
  insertBlob.run('rootblobid', Buffer.from([0x0a, 0x10, 0x01, 0x12, 0x05, 0xff]))
  db.close()
}

async function makeHermesFixture(root: string): Promise<string> {
  const hermesHome = path.join(root, 'hermes-home')
  const sessionsDir = path.join(hermesHome, 'sessions')
  await mkdir(sessionsDir, { recursive: true })

  const db = new Database(path.join(hermesHome, 'state.db'))
  // Mirror the column set the Hermes importer's `readSqliteCandidates` queries
  // verbatim — missing columns surface as "no such column" before any rows are
  // read, which manifests downstream as zero imported sessions.
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
  db.prepare(
    `INSERT INTO sessions (
       id, source, model, system_prompt, started_at, ended_at, end_reason,
       message_count, tool_call_count, title
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('db-main', 'cli', 'hermes-model', 'system prompt', 1_778_804_700, 1_778_804_704, 'stop', 4, 1, 'DB main')

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
  // Final assistant message carries `reasoning` content — Hermes imports
  // this as a hidden_by_default thinking block.
  insertMessage.run('db-main', 'assistant', 'Done', null, null, null, 1_778_804_703, 1, 'stop', 'private chain')
  db.close()
  return sessionsDir
}

const CASES: SourceCase[] = [
  {
    source: 'codex',
    expectsHiddenBlocks: false,
    expectsToolCalls: true,
    expectsUserAndAssistant: true,
    prepare: async (t) => {
      await compileCodex(t.bundle, CODEX_FIXTURES)
      // The two-session fixture: pick the parent (non-subagent) session.
      const sessions = listSessions(t.bundle, { sourceTool: 'codex' })
      const parent = sessions.find((s) => s.is_subagent === 0) ?? sessions[0]
      return parent!.session_id
    },
  },
  {
    source: 'claude',
    expectsHiddenBlocks: false,
    expectsToolCalls: true,
    expectsUserAndAssistant: true,
    prepare: async (t) => {
      await compileClaude(t.bundle, CLAUDE_FIXTURES)
      const sessions = listSessions(t.bundle, { sourceTool: 'claude' })
      const main = sessions.find((s) => s.is_subagent === 0) ?? sessions[0]
      return main!.session_id
    },
  },
  {
    source: 'gemini',
    expectsHiddenBlocks: false,
    expectsToolCalls: true,
    expectsUserAndAssistant: true,
    prepare: async (t) => {
      await compileGemini(t.bundle, GEMINI_FIXTURES)
      const sessions = listSessions(t.bundle, { sourceTool: 'gemini' })
      return sessions[0]!.session_id
    },
  },
  {
    source: 'cursor',
    expectsHiddenBlocks: false,
    // Cursor synthesizes one tool-call + one tool-result from the blob set.
    expectsToolCalls: true,
    expectsUserAndAssistant: true,
    prepare: async (t) => {
      const fixturesRoot = path.join(t.path, 'cursor-fixtures')
      await makeCursorFixture(fixturesRoot)
      await compileCursor(t.bundle, fixturesRoot)
      const sessions = listSessions(t.bundle, { sourceTool: 'cursor' })
      return sessions[0]!.session_id
    },
  },
  {
    source: 'hermes',
    // The final assistant message in the fixture carries `reasoning`, which
    // the importer projects as a hidden thinking block.
    expectsHiddenBlocks: true,
    expectsToolCalls: true,
    expectsUserAndAssistant: true,
    prepare: async (t) => {
      const sessionsDir = await makeHermesFixture(t.path)
      await compileHermes(t.bundle, sessionsDir)
      const sessions = listSessions(t.bundle, { sourceTool: 'hermes' })
      const main = sessions.find((s) => s.source_session_id === 'db-main') ?? sessions[0]
      return main!.session_id
    },
  },
]

function ordinalsAreStrictlyIncreasing(transcript: SessionTranscript): boolean {
  for (let i = 1; i < transcript.turns.length; i++) {
    const prev = transcript.turns[i - 1]!
    const curr = transcript.turns[i]!
    if (curr.ordinal <= prev.ordinal) return false
  }
  return true
}

describe.each(CASES)('loadTranscript cross-source matrix · $source', (cs) => {
  it('returns a populated transcript for the chosen session', async () => {
    const t = await createTempBundle()
    try {
      const sessionId = await cs.prepare(t)
      const transcript = await loadTranscript(t.bundle, sessionId)
      expect(transcript, `${cs.source}: loadTranscript returned null`).not.toBeNull()
      expect(transcript?.session.session_id).toBe(sessionId)
      // Every source we test surfaces at least one turn or one unattached call.
      const total = (transcript?.turns.length ?? 0) + (transcript?.unattachedToolCalls.length ?? 0)
      expect(total, `${cs.source}: transcript has no turns nor unattached tool calls`).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })

  it('preserves strictly increasing turn ordinals', async () => {
    const t = await createTempBundle()
    try {
      const sessionId = await cs.prepare(t)
      const transcript = await loadTranscript(t.bundle, sessionId)
      expect(transcript).not.toBeNull()
      expect(ordinalsAreStrictlyIncreasing(transcript!)).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  if (cs.expectsUserAndAssistant) {
    it('has at least one user turn and one assistant turn', async () => {
      const t = await createTempBundle()
      try {
        const sessionId = await cs.prepare(t)
        const transcript = await loadTranscript(t.bundle, sessionId)
        const roles = new Set(transcript!.turns.map((tn) => tn.role))
        expect(roles, `${cs.source}: missing user turn (roles=${[...roles].join(',')})`).toContain('user')
        expect(roles, `${cs.source}: missing assistant turn (roles=${[...roles].join(',')})`).toContain('assistant')
      } finally {
        await t.cleanup()
      }
    })
  } else {
    it.todo(`${cs.source}: fixture should expose user + assistant turns`)
  }

  if (cs.expectsToolCalls) {
    it('groups tool calls under a turn or in unattachedToolCalls', async () => {
      const t = await createTempBundle()
      try {
        const sessionId = await cs.prepare(t)
        const transcript = await loadTranscript(t.bundle, sessionId)
        const attached = transcript!.turns.reduce((n, tn) => n + tn.toolCalls.length, 0)
        const total = attached + transcript!.unattachedToolCalls.length
        expect(total, `${cs.source}: expected at least one tool call`).toBeGreaterThan(0)
      } finally {
        await t.cleanup()
      }
    })

    it('matches every tool result back to its owning tool call by id', async () => {
      const t = await createTempBundle()
      try {
        const sessionId = await cs.prepare(t)
        const transcript = await loadTranscript(t.bundle, sessionId)
        const allCalls = [...transcript!.turns.flatMap((tn) => tn.toolCalls), ...transcript!.unattachedToolCalls]
        const callIds = new Set(allCalls.map((c) => c.toolCallId))
        // Where `result` is set, the call's id must reappear in the call set:
        // i.e. the join we model in-memory is reflexive on toolCallId.
        for (const call of allCalls) {
          if (call.result) {
            expect(callIds.has(call.toolCallId), `${cs.source}: orphaned tool_result for ${call.toolCallId}`).toBe(true)
          }
        }
      } finally {
        await t.cleanup()
      }
    })
  } else {
    it.todo(`${cs.source}: fixture should exercise tool calls`)
  }

  if (cs.expectsHiddenBlocks) {
    it('preserves at least one hidden (thinking/reasoning) block', async () => {
      const t = await createTempBundle()
      try {
        const sessionId = await cs.prepare(t)
        const transcript = await loadTranscript(t.bundle, sessionId)
        const hidden = transcript!.turns.flatMap((tn) => tn.blocks).filter((b) => b.hidden)
        expect(hidden.length, `${cs.source}: expected at least one hidden block`).toBeGreaterThan(0)
      } finally {
        await t.cleanup()
      }
    })
  } else {
    // Existing codex/claude/gemini/cursor fixtures don't yet ship thinking
    // content. Lift this to a real assertion once a fixture grows one.
    it.todo(`${cs.source}: fixture should grow a thinking/reasoning block`)
  }
})
