import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { closeBundle, initBundle } from '@c3-oss/prosa-core'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { queryCount } from '../helpers/tmp-bundle.js'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const BIN = path.join(ROOT, 'src/bin/prosa.ts')
const CODEX_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/codex')
const CLAUDE_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/claude')
const GEMINI_FIXTURES = path.join(ROOT, '../../packages/prosa-core/test/fixtures/gemini')

describe('compile CLI', () => {
  it('imports Codex sessions from the default sessions path', async () => {
    const t = await makeTempRun()
    try {
      await copyFixture(CODEX_FIXTURES, path.join(t.homePath, '.codex', 'sessions'))

      const { stderr } = await runProsa(['compile', 'codex'], t.env)

      expect(stderr).toContain('codex batch completed')
      expect(stderr).toContain('"source_files_seen": 2')
      expect(stderr).toContain('"source_files_imported": 2')
      expect(stderr).toContain('INFO')
      expect(stderr).not.toContain('DEBUG')
    } finally {
      await t.cleanup()
    }
  })

  it('imports all providers from their default sessions paths', async () => {
    const t = await makeTempRun()
    try {
      await copyFixture(CODEX_FIXTURES, path.join(t.homePath, '.codex', 'sessions'))
      await copyFixture(CLAUDE_FIXTURES, path.join(t.homePath, '.claude', 'projects'))
      await copyFixture(GEMINI_FIXTURES, path.join(t.homePath, '.gemini', 'tmp'))
      await makeCursorFixture(path.join(t.homePath, '.cursor', 'chats'))
      await makeHermesFixture(path.join(t.homePath, '.hermes', 'sessions'))

      const { stderr } = await runProsa(['compile-all', '--verbose'], t.env)

      expect(stderr).toMatch(/codex batch completed/)
      expect(stderr).toMatch(/claude batch completed/)
      expect(stderr).toMatch(/gemini batch completed/)
      expect(stderr).toMatch(/cursor batch completed/)
      expect(stderr).toMatch(/hermes batch completed/)
      expect(stderr).toContain('"source_files_seen": 2')
      expect(stderr).toContain('"source_files_seen": 1')
      expect(stderr).toContain('DEBUG')

      // Tantivy and Parquet sidecar indexes should be rebuilt automatically.
      expect(stderr).toMatch(/rebuilding tantivy index/)
      expect(stderr).toMatch(/parquet export finished/)

      // Decoded JSON is no longer double-stored for parsed Codex/Claude
      // raw_records — the raw line itself IS the JSON.
      const db = new Database(path.join(t.storePath, 'prosa.sqlite'), { readonly: true })
      try {
        expect(
          queryCount(
            db,
            `SELECT count(*) AS n FROM raw_records
              WHERE source_tool = 'codex'
                AND parser_status = 'ok'
                AND decoded_json_object_id IS NOT NULL`,
          ),
        ).toBe(0)
        expect(
          queryCount(
            db,
            `SELECT count(*) AS n FROM raw_records
              WHERE source_tool = 'claude'
                AND parser_status = 'ok'
                AND decoded_json_object_id IS NOT NULL`,
          ),
        ).toBe(0)
        expect(
          queryCount(
            db,
            `SELECT count(*) AS n FROM sessions
              WHERE source_tool = 'hermes'
                AND source_session_id = 'hermes-cli-test'`,
          ),
        ).toBe(1)
      } finally {
        db.close()
      }
    } finally {
      await t.cleanup()
    }
  })

  it('emits debug logs when --verbose is passed before the compile provider', async () => {
    const t = await makeTempRun()
    try {
      await copyFixture(CODEX_FIXTURES, path.join(t.homePath, '.codex', 'sessions'))

      const { stderr } = await runProsa(['compile', '--verbose', 'codex'], t.env)

      expect(stderr).toContain('DEBUG')
      expect(stderr).toContain('codex source file discovered')
    } finally {
      await t.cleanup()
    }
  })

  it('emits raw JSON logs when --json-logs is passed', async () => {
    const t = await makeTempRun()
    try {
      await copyFixture(CODEX_FIXTURES, path.join(t.homePath, '.codex', 'sessions'))

      const { stderr } = await runProsa(['compile', 'codex', '--json-logs'], t.env)

      const lines = stderr
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('{'))
      expect(lines.length).toBeGreaterThan(0)
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 30,
            msg: 'opening bundle',
          }),
        ]),
      )
    } finally {
      await t.cleanup()
    }
  })

  it('rejects the legacy provider flag syntax', async () => {
    const t = await makeTempRun()
    try {
      const error = await runProsa(['compile', '--codex', CODEX_FIXTURES], t.env).catch((err: unknown) => err)

      expect(error).toMatchObject({
        stderr: expect.stringContaining("unknown option '--codex'"),
      })
    } finally {
      await t.cleanup()
    }
  })

  it('rejects unknown flags on compile-all', async () => {
    const t = await makeTempRun()
    try {
      const error = await runProsa(['compile-all', '--not-a-flag'], t.env).catch((err: unknown) => err)

      expect(error).toMatchObject({
        stderr: expect.stringContaining("unknown option '--not-a-flag'"),
      })
    } finally {
      await t.cleanup()
    }
  })
})

async function makeTempRun(): Promise<{
  homePath: string
  storePath: string
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'prosa-compile-cli-'))
  const homePath = path.join(rootPath, 'home')
  const storePath = path.join(rootPath, 'store')
  await mkdir(homePath, { recursive: true })
  const bundle = await initBundle(storePath)
  closeBundle(bundle)

  return {
    homePath,
    storePath,
    env: {
      ...process.env,
      HOME: homePath,
      PROSA_STORE: storePath,
    },
    cleanup: async () => {
      await rm(rootPath, { recursive: true, force: true })
    },
  }
}

async function copyFixture(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, { recursive: true })
}

async function makeCursorFixture(root: string): Promise<void> {
  const workspaceId = 'workspace-test'
  const agentId = '64a9033f-00d4-4870-af5a-d2331bde2876'
  const dir = path.join(root, workspaceId, agentId)
  await mkdir(dir, { recursive: true })

  const db = new Database(path.join(dir, 'store.db'))
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
  const metaHex = Buffer.from(JSON.stringify(meta), 'utf8').toString('hex')
  db.prepare(`INSERT INTO meta(key, value) VALUES ('0', ?)`).run(metaHex)

  const insertBlob = db.prepare(`INSERT INTO blobs(id, data) VALUES (?, ?)`)
  insertBlob.run('sys1', Buffer.from(JSON.stringify({ role: 'system', content: 'System.' })))
  insertBlob.run('u1', Buffer.from(JSON.stringify({ role: 'user', content: 'list files' })))
  insertBlob.run(
    'a1',
    Buffer.from(
      JSON.stringify({
        role: 'assistant',
        id: 'a1',
        content: [
          { type: 'text', text: 'Listing now.' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls' } },
        ],
      }),
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
            result: 'total 0',
            experimental_content: { isError: false },
          },
        ],
      }),
    ),
  )
  insertBlob.run('rootblobid', Buffer.from([0x0a, 0x10, 0x01]))
  db.close()
}

async function makeHermesFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, '.keep'), '', 'utf8')

  const db = new Database(path.join(path.dirname(root), 'state.db'))
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
       id, source, model, started_at, ended_at, end_reason, message_count, title
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('hermes-cli-test', 'cli', 'hermes-test-model', 1_778_805_000, 1_778_805_001, 'stop', 2, 'Hermes CLI test')
  db.prepare(
    `INSERT INTO messages (
       session_id, role, content, timestamp, token_count, finish_reason
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('hermes-cli-test', 'user', 'hello hermes', 1_778_805_000, 2, null)
  db.prepare(
    `INSERT INTO messages (
       session_id, role, content, timestamp, token_count, finish_reason
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('hermes-cli-test', 'assistant', 'hello from hermes', 1_778_805_001, 3, 'stop')
  db.close()
}

function runProsa(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', BIN, ...args],
    {
      cwd: ROOT,
      env,
    },
  )
}
