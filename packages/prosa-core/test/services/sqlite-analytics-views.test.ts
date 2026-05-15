import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compileCodex } from '../../src/importers/codex/index.js'
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex')

describe('SQLite analytics views', () => {
  it('creates analytics views in the SQLite schema and counts match canonical tables', async () => {
    const t = await createTempBundle()
    try {
      await compileCodex(t.bundle, CODEX_FIXTURES)

      const viewNames = t.bundle.db
        .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name`)
        .all()
        .map((row) => row.name)
      expect(viewNames).toEqual(['error_facts', 'model_usage', 'project_activity', 'session_facts', 'tool_usage_facts'])

      expect(queryCount(t.bundle.db, 'SELECT count(*) AS n FROM session_facts')).toBe(2)
      expect(queryCount(t.bundle.db, 'SELECT count(*) AS n FROM tool_usage_facts')).toBe(2)
      expect(queryCount(t.bundle.db, 'SELECT count(*) AS n FROM project_activity')).toBeGreaterThan(0)
      expect(queryCount(t.bundle.db, `SELECT count(*) AS n FROM model_usage WHERE model = 'gpt-5.4'`)).toBe(1)

      const sessions = t.bundle.db
        .prepare<
          [],
          {
            session_id: string
            source_tool: string
            message_count: number
            tool_call_count: number
          }
        >(
          `SELECT session_id, source_tool, message_count, tool_call_count
             FROM session_facts
            ORDER BY session_id`,
        )
        .all()
      expect(sessions.every((row) => row.source_tool === 'codex')).toBe(true)
      expect(sessions.every((row) => row.message_count > 0)).toBe(true)
    } finally {
      await t.cleanup()
    }
  })
})
