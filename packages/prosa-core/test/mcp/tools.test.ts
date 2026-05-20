import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'
import { PROSA_MCP_INSTRUCTIONS } from '../../src/mcp/guidance.js'
import { registerProsaTools } from '../../src/mcp/tools.js'
import { extractPromptText, extractText } from '../helpers/mcp.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '../..')
const CODEX_FIXTURES = path.join(ROOT, 'test/fixtures/codex')

interface CapturedTool {
  config: { description?: string }
  callback: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> | unknown
}

interface CapturedPrompt {
  config: { description?: string }
  callback: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> | unknown
}

class FakeMcpServer {
  tools = new Map<string, CapturedTool>()
  prompts = new Map<string, CapturedPrompt>()

  registerTool(name: string, config: CapturedTool['config'], callback: CapturedTool['callback']): unknown {
    this.tools.set(name, { config, callback })
    return {}
  }

  registerPrompt(name: string, config: CapturedPrompt['config'], callback: CapturedPrompt['callback']): unknown {
    this.prompts.set(name, { config, callback })
    return {}
  }
}

describe('prosa MCP surface', () => {
  it('registers exactly six tools and three prompts', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, { searchEngine: 'tantivy' })

      expect([...server.tools.keys()].sort()).toEqual([
        'analytics',
        'artifact',
        'compile',
        'search',
        'sessions',
        'tool_calls',
      ])
      expect([...server.prompts.keys()].sort()).toEqual([
        'audit_tool_failures',
        'find_file_history',
        'investigate_prior_work',
      ])
      expect(server.tools.get('search')?.config.description).toContain('tantivy')

      const prompt = server.prompts.get('investigate_prior_work')
      expect(prompt).toBeDefined()
      const promptResult = await prompt!.callback({ topic: 'search indexing' }, {})
      expect(extractPromptText(promptResult)).toContain('search indexing')
      expect(extractPromptText(promptResult)).toContain('sessions session_id')

      const findHistory = server.prompts.get('find_file_history')
      expect(findHistory).toBeDefined()
      const findResult = await findHistory!.callback({ path: 'src/services/search.ts' }, {})
      expect(extractPromptText(findResult)).toContain('src/services/search.ts')
      expect(extractPromptText(findResult)).toContain('tool_calls')

      const audit = server.prompts.get('audit_tool_failures')
      expect(audit).toBeDefined()
      const auditWithQuery = await audit!.callback({ query: 'shell timeout' }, {})
      expect(extractPromptText(auditWithQuery)).toContain('related to: shell timeout')
      const auditNoQuery = await audit!.callback({}, {})
      expect(extractPromptText(auditNoQuery)).toContain('Audit tool failures in prosa.')
    } finally {
      await t.cleanup()
    }
  })

  it('exposes MCP server instructions naming the six tools', () => {
    expect(PROSA_MCP_INSTRUCTIONS).toContain('search')
    expect(PROSA_MCP_INSTRUCTIONS).toContain('sessions')
    expect(PROSA_MCP_INSTRUCTIONS).toContain('tool_calls')
    expect(PROSA_MCP_INSTRUCTIONS).toContain('analytics')
    expect(PROSA_MCP_INSTRUCTIONS).toContain('artifact')
    expect(PROSA_MCP_INSTRUCTIONS).toContain('compile')
  })

  it('compile mode without args returns a status snapshot, with args runs an idempotent import', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      const storePath = path.join(t.path, 'mcp-store')
      expect(await pathExists(storePath)).toBe(false)
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath,
      })

      const compile = server.tools.get('compile')
      expect(compile).toBeDefined()

      const status = await compile!.callback({}, {})
      const statusPayload = JSON.parse(extractText(status)) as {
        mode: string
        search_index: Array<{ engine: string; status: string }>
      }
      expect(statusPayload.mode).toBe('status')
      expect(statusPayload.search_index.map((row) => row.engine).sort()).toEqual(['fts5', 'tantivy'])

      const first = await compile!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})
      expect(await pathExists(path.join(storePath, 'manifest.json'))).toBe(true)
      const firstPayload = JSON.parse(extractText(first)) as {
        mode: string
        imported_any: boolean
        providers: Array<{
          source: string
          source_path: string
          counts: { source_files_imported: number; source_files_skipped: number }
        }>
      }
      expect(firstPayload.mode).toBe('import')
      expect(firstPayload.imported_any).toBe(true)
      expect(firstPayload.providers).toHaveLength(1)
      expect(firstPayload.providers[0]).toMatchObject({
        source: 'codex',
        source_path: CODEX_FIXTURES,
      })
      expect(firstPayload.providers[0]?.counts.source_files_imported).toBe(2)

      const second = await compile!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})
      const secondPayload = JSON.parse(extractText(second)) as {
        imported_any: boolean
        providers: Array<{
          counts: { source_files_imported: number; source_files_skipped: number }
        }>
      }
      expect(secondPayload.imported_any).toBe(false)
      expect(secondPayload.providers[0]?.counts.source_files_imported).toBe(0)
      expect(secondPayload.providers[0]?.counts.source_files_skipped).toBe(2)

      const invalid = await compile!.callback({ sessions_path: CODEX_FIXTURES }, {})
      expect((invalid as { isError?: boolean }).isError).toBe(true)
      expect(extractText(invalid)).toContain('sessions_path requires source')
    } finally {
      await t.cleanup()
    }
  })

  it('search returns FTS5 hits and respects field_kind filter', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath: t.path,
      })
      const compile = server.tools.get('compile')!
      await compile.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})

      const search = server.tools.get('search')
      expect(search).toBeDefined()
      const result = await search!.callback({ query: 'terraform', limit: 10 }, {})
      const payload = JSON.parse(extractText(result)) as {
        query: string
        engine: string
        count: number
        hits: Array<{ field_kind: string }>
      }
      expect(payload.query).toBe('terraform')
      expect(payload.engine).toBe('fts5')
      expect(payload.count).toBeGreaterThan(0)

      const filtered = await search!.callback({ query: 'terraform', field_kind: 'command' }, {})
      const filteredPayload = JSON.parse(extractText(filtered)) as {
        hits: Array<{ field_kind: string }>
      }
      for (const hit of filteredPayload.hits) {
        expect(hit.field_kind).toBe('command')
      }

      // Whitespace-only query collapses to empty FTS expression and returns no hits.
      const empty = await search!.callback({ query: '   ' }, {})
      const emptyPayload = JSON.parse(extractText(empty)) as { count: number }
      expect(emptyPayload.count).toBe(0)

      // Raw passthrough exercises the `raw` branch.
      const rawHit = await search!.callback({ query: '"terraform"', raw: true, limit: 5 }, {})
      const rawPayload = JSON.parse(extractText(rawHit)) as { count: number }
      expect(rawPayload.count).toBeGreaterThanOrEqual(0)
    } finally {
      await t.cleanup()
    }
  })

  it('sessions tool lists when no session_id, returns detail/summary/markdown when given', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath: t.path,
      })
      await server.tools.get('compile')!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})

      const sessions = server.tools.get('sessions')
      expect(sessions).toBeDefined()

      const list = await sessions!.callback({ source: 'codex' }, {})
      const listed = JSON.parse(extractText(list)) as Array<{ session_id: string }>
      expect(listed.length).toBe(2)
      const sessionId = listed[0]!.session_id

      const detail = await sessions!.callback({ session_id: sessionId, format: 'detail' }, {})
      const detailPayload = JSON.parse(extractText(detail)) as {
        session: { session_id: string }
        events: unknown[]
      }
      expect(detailPayload.session.session_id).toBe(sessionId)
      expect(Array.isArray(detailPayload.events)).toBe(true)

      const summary = await sessions!.callback({ session_id: sessionId, format: 'summary' }, {})
      const summaryPayload = JSON.parse(extractText(summary)) as {
        session: { session_id: string }
        events?: unknown[]
      }
      expect(summaryPayload.session.session_id).toBe(sessionId)
      expect(summaryPayload.events).toBeUndefined()

      const md = await sessions!.callback({ session_id: sessionId, format: 'markdown' }, {})
      const mdText = extractText(md)
      expect(mdText.length).toBeGreaterThan(0)
      expect(mdText).toContain('user')

      const missingDetail = await sessions!.callback({ session_id: 'does-not-exist', format: 'detail' }, {})
      expect((missingDetail as { isError?: boolean }).isError).toBe(true)
      expect(extractText(missingDetail)).toContain('session not found')

      const missingMd = await sessions!.callback({ session_id: 'does-not-exist', format: 'markdown' }, {})
      expect((missingMd as { isError?: boolean }).isError).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('tool_calls tool filters tool calls and unions matching artifacts when path_substring is set', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath: t.path,
      })
      await server.tools.get('compile')!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})

      const tool = server.tools.get('tool_calls')
      expect(tool).toBeDefined()

      const all = await tool!.callback({ canonical_type: 'shell' }, {})
      const allRows = JSON.parse(extractText(all)) as Array<{
        entity_type: string
        canonical_tool_type: string
      }>
      expect(allRows.length).toBeGreaterThan(0)
      expect(allRows.every((row) => row.entity_type === 'tool_call')).toBe(true)
      expect(allRows.every((row) => row.canonical_tool_type === 'shell')).toBe(true)

      const byPath = await tool!.callback({ path_substring: '/' }, {})
      const byPathRows = JSON.parse(extractText(byPath)) as Array<{ entity_type: string }>
      expect(Array.isArray(byPathRows)).toBe(true)
    } finally {
      await t.cleanup()
    }
  })

  it('analytics tool runs each report against SQLite views and applies session filter', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath: t.path,
      })
      await server.tools.get('compile')!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})

      const analytics = server.tools.get('analytics')
      expect(analytics).toBeDefined()

      const sessionsReport = await analytics!.callback(
        { report: 'sessions', source_path_substring: 'fixtures/codex', limit: 10 },
        {},
      )
      const sessionsPayload = JSON.parse(extractText(sessionsReport)) as {
        report: string
        rows: Array<{ source_tool: string; source_file_path: string; message_count: number }>
      }
      expect(sessionsPayload.report).toBe('sessions')
      expect(sessionsPayload.rows.length).toBe(2)
      expect(sessionsPayload.rows.every((row) => row.source_file_path?.includes('fixtures/codex'))).toBe(true)
      expect(sessionsPayload.rows.every((row) => row.source_tool === 'codex')).toBe(true)

      for (const report of ['tools', 'errors', 'models', 'projects'] as const) {
        const result = await analytics!.callback({ report }, {})
        const payload = JSON.parse(extractText(result)) as { report: string; rows: unknown[] }
        expect(payload.report).toBe(report)
        expect(Array.isArray(payload.rows)).toBe(true)
      }
    } finally {
      await t.cleanup()
    }
  })

  it('artifact tool returns text for known ids and an error for unknown ids', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath: t.path,
      })
      await server.tools.get('compile')!.callback({ source: 'codex', sessions_path: CODEX_FIXTURES }, {})

      const artifact = server.tools.get('artifact')
      expect(artifact).toBeDefined()
      const missing = await artifact!.callback({ artifact_id: 'does-not-exist' }, {})
      expect((missing as { isError?: boolean }).isError).toBe(true)
      expect(extractText(missing)).toContain('artifact not found')
    } finally {
      await t.cleanup()
    }
  })

  it('initializes a missing store before a read-only tool runs', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      const storePath = path.join(t.path, 'read-only-mcp-store')
      expect(await pathExists(storePath)).toBe(false)
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        ensureStore: true,
        storePath,
      })

      const compile = server.tools.get('compile')
      expect(compile).toBeDefined()
      const result = await compile!.callback({}, {})

      expect(await pathExists(path.join(storePath, 'manifest.json'))).toBe(true)
      const payload = JSON.parse(extractText(result)) as {
        mode: string
        search_index: Array<{ engine: string }>
      }
      expect(payload.mode).toBe('status')
      expect(payload.search_index.map((r) => r.engine).sort()).toEqual(['fts5', 'tantivy'])
    } finally {
      await t.cleanup()
    }
  })
  it('CQ-149 — registers `prosa.refresh_authority` only when onRefreshAuthority is provided', async () => {
    const t = await createTempBundle()
    try {
      const without = new FakeMcpServer()
      registerProsaTools(without as unknown as McpServer, t.bundle, {})
      expect(without.tools.has('prosa.refresh_authority')).toBe(false)

      let refreshes = 0
      const onRefreshAuthority = async () => {
        refreshes += 1
        return { receiptId: 'r-fresh', auditStatus: 'ok', refreshedAt: '2026-05-20T11:00:00.000Z' }
      }
      const withRefresh = new FakeMcpServer()
      registerProsaTools(withRefresh as unknown as McpServer, t.bundle, { onRefreshAuthority })
      expect(withRefresh.tools.has('prosa.refresh_authority')).toBe(true)

      const tool = withRefresh.tools.get('prosa.refresh_authority')!
      const result = await tool.callback({}, {})
      expect(refreshes).toBe(1)
      const parsed = JSON.parse(extractText(result)) as { receiptId: string; auditStatus: string }
      expect(parsed.receiptId).toBe('r-fresh')
      expect(parsed.auditStatus).toBe('ok')
    } finally {
      await t.cleanup()
    }
  })

  it('CQ-149 — refresh_authority surfaces callback errors as isError', async () => {
    const t = await createTempBundle()
    try {
      const server = new FakeMcpServer()
      registerProsaTools(server as unknown as McpServer, t.bundle, {
        onRefreshAuthority: async () => {
          throw new Error('upstream refresh failed')
        },
      })
      const tool = server.tools.get('prosa.refresh_authority')!
      const result = (await tool.callback({}, {})) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain('upstream refresh failed')
    } finally {
      await t.cleanup()
    }
  })
})

async function pathExists(p: string): Promise<boolean> {
  return stat(p)
    .then(() => true)
    .catch(() => false)
}
