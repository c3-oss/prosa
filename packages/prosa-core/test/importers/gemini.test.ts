import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getText } from '../../src/core/cas/index.js'
import { compileGemini } from '../../src/importers/gemini/index.js'
import { exportSessionMarkdown } from '../../src/services/export/markdown.js'
import { searchFullText } from '../../src/services/search.js'
import { listSessions } from '../../src/services/sessions.js'
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FIXTURES = path.resolve(__dirname, '../fixtures/gemini')

if (!existsSync(FIXTURES)) {
  throw new Error(`fixtures missing at ${FIXTURES}`)
}

describe('gemini importer', () => {
  it('compiles the synthetic chat including tool call and project link', async () => {
    const t = await createTempBundle()
    try {
      const result = await compileGemini(t.bundle, FIXTURES)
      expect(result.counts.source_files_seen).toBe(1)
      expect(result.counts.sessions).toBe(1)
      expect(result.counts.messages).toBe(3) // user + 2 gemini; info/error are events
      expect(result.counts.tool_calls).toBe(1)
      expect(result.counts.tool_results).toBe(1)

      const sessions = listSessions(t.bundle, { sourceTool: 'gemini' })
      expect(sessions).toHaveLength(1)

      const project = t.bundle.db
        .prepare<[], { canonical_path: string | null }>(`SELECT canonical_path FROM projects LIMIT 1`)
        .get()
      expect(project?.canonical_path).toBe('/Users/test/proj')

      const md = await exportSessionMarkdown(t.bundle, sessions[0]!.session_id)
      expect(md).toMatch(/Read package.json/)
      expect(md).toMatch(/tool: read_file/)
    } finally {
      await t.cleanup()
    }
  })

  it('treats info and error message types as operational events, not messages', async () => {
    const t = await createTempBundle()
    try {
      await compileGemini(t.bundle, FIXTURES)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages`)).toBe(3)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM events WHERE event_type = 'error'`)).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('hides thoughts from default search', async () => {
    const t = await createTempBundle()
    try {
      await compileGemini(t.bundle, FIXTURES)
      const hits = searchFullText(t.bundle, { query: 'summarize' })
      expect(hits.length).toBe(0)
      const found = searchFullText(t.bundle, { query: 'package.json' })
      expect(found.length).toBeGreaterThan(0)
    } finally {
      await t.cleanup()
    }
  })

  it('is idempotent', async () => {
    const t = await createTempBundle()
    try {
      const r1 = await compileGemini(t.bundle, FIXTURES)
      expect(r1.counts.source_files_imported).toBe(1)
      const r2 = await compileGemini(t.bundle, FIXTURES)
      expect(r2.counts.source_files_imported).toBe(0)
      expect(r2.counts.source_files_skipped).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('links hash-directory sessions to a Gemini project row', async () => {
    const t = await createTempBundle()
    try {
      const hash = 'a'.repeat(64)
      await writeGeminiChat(t.path, hash, 'session-hash.json', {
        sessionId: 'hash-session',
        projectHash: hash,
        messages: [{ type: 'user', id: 'u1', content: 'hello' }],
      })

      await compileGemini(t.bundle, t.path)

      const project = t.bundle.db
        .prepare<[], { source_project_id: string; canonical_path: string | null }>(
          `SELECT source_project_id, canonical_path FROM projects`,
        )
        .get()
      expect(project).toEqual({ source_project_id: hash, canonical_path: null })
      expect(listSessions(t.bundle, { sourceTool: 'gemini' })[0]?.project_id).not.toBeNull()
    } finally {
      await t.cleanup()
    }
  })

  it('preserves Gemini resultDisplay file contents as artifacts', async () => {
    const t = await createTempBundle()
    try {
      await writeGeminiChat(t.path, 'proj', 'session-artifacts.json', {
        sessionId: 'artifact-session',
        messages: [
          {
            type: 'gemini',
            id: 'm1',
            toolCalls: [
              {
                id: 'tc1',
                name: 'codebase_investigator',
                status: 'success',
                resultDisplay: {
                  filePath: 'src/app.ts',
                  fileName: 'app.ts',
                  originalContent: 'old file',
                  newContent: 'new file',
                },
              },
            ],
          },
        ],
      })

      await compileGemini(t.bundle, t.path)

      expect(
        t.bundle.db.prepare<[], { canonical_tool_type: string }>(`SELECT canonical_tool_type FROM tool_calls`).get()
          ?.canonical_tool_type,
      ).toBe('other')
      const artifacts = t.bundle.db
        .prepare<[], { logical_path: string | null; text_object_id: string | null }>(
          `SELECT logical_path, text_object_id FROM artifacts WHERE kind = 'file' ORDER BY artifact_id`,
        )
        .all()
      expect(artifacts).toHaveLength(2)
      expect(artifacts.map((artifact) => artifact.logical_path)).toEqual(['app.ts', 'app.ts'])
      const artifactTexts = await Promise.all(artifacts.map((artifact) => getText(t.bundle, artifact.text_object_id!)))
      expect(artifactTexts.sort()).toEqual(['new file', 'old file'])
    } finally {
      await t.cleanup()
    }
  })

  it('does not let later duplicate Gemini snapshots replace existing normalized rows', async () => {
    const t = await createTempBundle()
    try {
      await writeGeminiChat(t.path, 'proj', 'session-a.json', {
        sessionId: 'duplicate-session',
        summary: 'first snapshot',
        messages: [{ type: 'user', id: 'u1', content: 'first' }],
      })
      await writeGeminiChat(t.path, 'proj', 'session-b.json', {
        sessionId: 'duplicate-session',
        summary: 'second snapshot',
        messages: [{ type: 'user', id: 'u1', content: 'second' }],
      })

      await compileGemini(t.bundle, t.path)

      const session = listSessions(t.bundle, { sourceTool: 'gemini' })[0]
      expect(session?.title).toBe('first snapshot')
      expect(searchFullText(t.bundle, { query: 'first' })).toHaveLength(1)
      expect(searchFullText(t.bundle, { query: 'second' })).toHaveLength(0)
      // Both snapshots' raw bytes are preserved; only the normalized tables collapse.
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages`)).toBe(1)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM events`)).toBe(1)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM content_blocks`)).toBe(1)
      expect(queryCount(t.bundle.db, `SELECT count(DISTINCT source_file_id) AS n FROM raw_records`)).toBe(2)
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM import_errors WHERE kind = ?`, 'gemini_duplicate_snapshot'),
      ).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('logs every duplicate snapshot as a single import_errors row per file', async () => {
    const t = await createTempBundle()
    try {
      await writeGeminiChat(t.path, 'proj', 'session-a.json', {
        sessionId: 'ordinal-collision',
        summary: 'first snapshot',
        messages: [
          { type: 'user', id: 'u1', content: 'alpha' },
          { type: 'gemini', id: 'm2', content: 'beta' },
          { type: 'user', id: 'u3', content: 'gamma' },
        ],
      })
      await writeGeminiChat(t.path, 'proj', 'session-b.json', {
        sessionId: 'ordinal-collision',
        summary: 'second snapshot',
        messages: [
          { type: 'user', id: 'u1', content: 'alpha-rewrite' },
          { type: 'gemini', id: 'm2', content: 'beta-rewrite' },
          { type: 'user', id: 'u3', content: 'gamma-rewrite' },
          { type: 'user', id: 'u4', content: 'delta-extra' },
        ],
      })

      await compileGemini(t.bundle, t.path)

      // Session row: one (first sorted snapshot's title wins).
      expect(listSessions(t.bundle, { sourceTool: 'gemini' })).toHaveLength(1)
      expect(listSessions(t.bundle, { sourceTool: 'gemini' })[0]?.title).toBe('first snapshot')
      // Overlapping ordinals from B are dropped: A's three messages persist; B's
      // ordinal-4 message lands because no row in A collides with its deterministic id.
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages`)).toBe(4)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages WHERE ordinal = 1`)).toBe(1)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM messages WHERE ordinal = 4`)).toBe(1)
      // A's content wins for ordinals 1-3, B's content wins for ordinal 4.
      expect(searchFullText(t.bundle, { query: 'alpha' })).toHaveLength(1)
      expect(searchFullText(t.bundle, { query: 'alpha-rewrite' })).toHaveLength(0)
      expect(searchFullText(t.bundle, { query: 'delta-extra' })).toHaveLength(1)
      // raw_records preserve every snapshot file as a distinct source file.
      expect(queryCount(t.bundle.db, `SELECT count(DISTINCT source_file_id) AS n FROM raw_records`)).toBe(2)
      // Exactly one duplicate-snapshot warning was logged.
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM import_errors WHERE kind = ?`, 'gemini_duplicate_snapshot'),
      ).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('does not emit a duplicate-snapshot warning for a unique sessionId', async () => {
    const t = await createTempBundle()
    try {
      await writeGeminiChat(t.path, 'proj', 'session-only.json', {
        sessionId: 'unique-session',
        summary: 'only snapshot',
        messages: [{ type: 'user', id: 'u1', content: 'hello' }],
      })

      await compileGemini(t.bundle, t.path)

      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM import_errors WHERE kind = ?`, 'gemini_duplicate_snapshot'),
      ).toBe(0)
    } finally {
      await t.cleanup()
    }
  })
})

async function writeGeminiChat(
  root: string,
  projectDir: string,
  filename: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const chatsDir = path.join(root, projectDir, 'chats')
  await mkdir(chatsDir, { recursive: true })
  await writeFile(path.join(chatsDir, filename), JSON.stringify(payload), 'utf8')
}
