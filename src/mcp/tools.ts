import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type Bundle, closeBundle, openOrInitBundle } from '../core/bundle.js'
import { getText } from '../core/cas/index.js'
import { SOURCE_TOOLS } from '../core/domain/types.js'
import { getErrorMessage } from '../core/errors.js'
import { ANALYTICS_REPORTS, type AnalyticsReportFilters, runAnalyticsReportFromBundle } from '../services/analytics.js'
import { COMPILE_PROVIDERS, exportCompileParquet, getCompileProvider, runCompileImports } from '../services/compile.js'
import { exportSessionMarkdown } from '../services/export/markdown.js'
import { type SearchEngine, getSearchIndexStatuses } from '../services/indexing.js'
import { searchFullText } from '../services/search.js'
import { getSession, listSessions } from '../services/sessions.js'
import { listToolCalls } from '../services/tool_calls.js'
import { AUDIT_TOOL_FAILURES_PROMPT, FIND_FILE_HISTORY_PROMPT, INVESTIGATE_PRIOR_WORK_PROMPT } from './guidance.js'

export interface ProsaToolOptions {
  searchEngine?: SearchEngine
  storePath?: string
  ensureStore?: boolean
}

const CANONICAL_TOOL_TYPES = [
  'shell',
  'read_file',
  'write_file',
  'edit_file',
  'search_file',
  'web_search',
  'mcp',
  'subagent',
  'patch',
  'other',
] as const

const FIELD_KINDS = [
  'message_text',
  'user_prompt',
  'assistant_text',
  'command',
  'command_output_preview',
  'error',
  'file_path',
  'diff',
  'summary',
  'artifact_text',
  'tool_args',
  'tool_result',
] as const

/**
 * Register the six prosa MCP tools on `server`. Five are read-only; `compile`
 * is dual-mode (no args = bundle status snapshot, with args = mutating import).
 */
export function registerProsaTools(server: McpServer, bundle: Bundle, options: ProsaToolOptions = {}): void {
  const searchEngine = options.searchEngine ?? 'fts5'
  const storePath = options.storePath ?? bundle.path
  const ensureStore = options.ensureStore ?? false
  registerProsaPrompts(server)

  server.registerTool(
    'search',
    {
      title: 'Full-text search',
      description: `Search messages, commands, paths, diffs, and result previews using the server-selected ${searchEngine} engine. Start here for open-ended questions with 2-5 concrete terms; then call \`sessions\` for relevant hits.`,
      inputSchema: {
        query: z.string().min(1),
        engine: z.enum(['fts5', 'tantivy']).optional(),
        field_kind: z.enum(FIELD_KINDS).optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
        raw: z
          .boolean()
          .optional()
          .default(false)
          .describe('Pass query straight to FTS5 MATCH (allows OR/NEAR/prefixes).'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, engine, field_kind, limit, raw }) =>
      withToolBundle(bundle, storePath, ensureStore, (activeBundle) => {
        const selectedEngine = engine ?? searchEngine
        const hits = searchFullText(activeBundle, {
          query,
          limit: limit ?? 50,
          raw,
          engine: selectedEngine,
        })
        const filtered = field_kind ? hits.filter((hit) => hit.field_kind === field_kind) : hits
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  query,
                  engine: selectedEngine,
                  field_kind: field_kind ?? null,
                  count: filtered.length,
                  hits: filtered,
                },
                null,
                2,
              ),
            },
          ],
        }
      }),
  )

  server.registerTool(
    'sessions',
    {
      title: 'List or open sessions',
      description:
        'Without `session_id`, lists sessions filtered by source/time/limit. With `session_id`, opens that session: `format=detail` (default) returns metadata plus timeline events; `format=summary` returns only the session row; `format=markdown` renders the readable transcript. Call after `search` to get evidence behind a hit.',
      inputSchema: {
        session_id: z.string().min(1).optional(),
        format: z.enum(['summary', 'detail', 'markdown']).optional().default('detail'),
        source: z.enum(SOURCE_TOOLS).optional(),
        since: z.string().optional().describe('ISO timestamp lower bound (inclusive)'),
        until: z.string().optional().describe('ISO timestamp upper bound (exclusive)'),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ session_id, format, source, since, until, limit }) =>
      withToolBundle(bundle, storePath, ensureStore, async (activeBundle) => {
        if (!session_id) {
          const rows = listSessions(activeBundle, {
            sourceTool: source,
            sinceIso: since,
            untilIso: until,
            limit: limit ?? 50,
          })
          return {
            content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
          }
        }

        if (format === 'markdown') {
          try {
            const md = await exportSessionMarkdown(activeBundle, session_id)
            return { content: [{ type: 'text', text: md }] }
          } catch (error) {
            return {
              content: [{ type: 'text', text: getErrorMessage(error) }],
              isError: true,
            }
          }
        }

        const detail = getSession(activeBundle, session_id)
        if (!detail) {
          return {
            content: [{ type: 'text', text: `session not found: ${session_id}` }],
            isError: true,
          }
        }
        const payload = format === 'summary' ? { session: detail.session } : detail
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        }
      }),
  )

  server.registerTool(
    'tool_calls',
    {
      title: 'Audit tool calls and file touches',
      description:
        'Audit commands and tool usage. Filter by tool_name, canonical_type, session_id, errors_only, or path_substring. When `path_substring` is set, also surfaces matching artifacts so file-history questions return both invocations and produced files.',
      inputSchema: {
        session_id: z.string().min(1).optional(),
        tool_name: z.string().optional(),
        canonical_type: z.enum(CANONICAL_TOOL_TYPES).optional(),
        path_substring: z
          .string()
          .min(1)
          .optional()
          .describe('Filter rows where tool_calls.path or artifacts.path contains this substring.'),
        errors_only: z.boolean().optional().default(false),
        since: z.string().optional().describe('ISO timestamp lower bound (inclusive)'),
        until: z.string().optional().describe('ISO timestamp upper bound (exclusive)'),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      withToolBundle(bundle, storePath, ensureStore, (activeBundle) => {
        const rows = listToolCalls(activeBundle, {
          sessionId: input.session_id,
          toolName: input.tool_name,
          canonicalType: input.canonical_type,
          pathSubstring: input.path_substring,
          errorsOnly: input.errors_only,
          sinceIso: input.since,
          untilIso: input.until,
          limit: input.limit ?? 100,
        })
        return {
          content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
        }
      }),
  )

  server.registerTool(
    'analytics',
    {
      title: 'Aggregate analytics reports',
      description:
        'Run a built-in aggregation over the bundle: per-session metrics (`sessions`), tool usage rollup (`tools`), error timeline (`errors`), model usage (`models`), or project activity (`projects`). Backed by SQLite views; mirrors the `prosa analytics` CLI.',
      inputSchema: {
        report: z.enum(ANALYTICS_REPORTS),
        source: z.enum(SOURCE_TOOLS).optional(),
        since: z.string().optional().describe('ISO timestamp lower bound (inclusive)'),
        until: z.string().optional().describe('ISO timestamp upper bound (exclusive)'),
        limit: z.number().int().min(1).max(500).optional().default(50),
        session_id: z.string().min(1).optional().describe('Drill-down filter (applies to `sessions` report).'),
        source_path_substring: z
          .string()
          .min(1)
          .optional()
          .describe('Filter `sessions` rows by imported source file path substring.'),
        project: z.string().min(1).optional().describe('Filter by project id, name, or path substring.'),
        tool_name: z.string().min(1).optional().describe('Filter `tools`/`errors` rows by exact tool name.'),
        canonical_type: z.enum(CANONICAL_TOOL_TYPES).optional().describe('Filter `tools` rows by canonical tool type.'),
        errors_only: z.boolean().optional().describe('`tools` report: only error rows.'),
        category: z
          .string()
          .min(1)
          .optional()
          .describe('Filter `errors` by category: tool_result|import_error|uncertainty.'),
        model: z.string().min(1).optional().describe('Filter `models` rows by exact model name.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) =>
      withToolBundle(bundle, storePath, ensureStore, (activeBundle) => {
        const filters: AnalyticsReportFilters = {
          source: input.source,
          since: input.since,
          until: input.until,
          limit: input.limit,
          sessionId: input.session_id,
          sourcePathSubstring: input.source_path_substring,
          project: input.project,
          toolName: input.tool_name,
          canonicalType: input.canonical_type,
          errorsOnly: input.errors_only,
          category: input.category,
          model: input.model,
        }
        try {
          const result = runAnalyticsReportFromBundle({
            bundle: activeBundle,
            report: input.report,
            filters,
          })
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ report: input.report, count: result.rows.length, rows: result.rows }, null, 2),
              },
            ],
          }
        } catch (error) {
          return {
            content: [{ type: 'text', text: getErrorMessage(error) }],
            isError: true,
          }
        }
      }),
  )

  server.registerTool(
    'artifact',
    {
      title: 'Get artifact bytes/text',
      description:
        'Retrieve full text for an `artifact_id` referenced in a session, search hit, or tool_calls row. Use this when previews are not enough; binary artifacts return a placeholder.',
      inputSchema: {
        artifact_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ artifact_id }) =>
      withToolBundle(bundle, storePath, ensureStore, async (activeBundle) => {
        const row = activeBundle.db
          .prepare<[string], { text_object_id: string | null; object_id: string | null; mime_type: string | null }>(
            `SELECT text_object_id, object_id, mime_type FROM artifacts WHERE artifact_id = ?`,
          )
          .get(artifact_id)
        if (!row) {
          return {
            content: [{ type: 'text', text: `artifact not found: ${artifact_id}` }],
            isError: true,
          }
        }
        const objectId = row.text_object_id ?? row.object_id
        if (!objectId) {
          return { content: [{ type: 'text', text: '[no content stored]' }] }
        }
        try {
          const text = await getText(activeBundle, objectId)
          return { content: [{ type: 'text', text }] }
        } catch {
          return { content: [{ type: 'text', text: `[binary artifact: ${objectId}]` }] }
        }
      }),
  )

  server.registerTool(
    'compile',
    {
      title: 'Compile sessions or report bundle status',
      description:
        'Without input, returns a status snapshot (search index health, last batch, schema version) without mutating anything. With `source`, imports that provider; `sessions_path` may override its default. Pass `overwrite: true` to force a full rebuild of derived indexes (Tantivy from scratch). With neither `source` nor `sessions_path`, only status is returned.',
      inputSchema: {
        source: z.enum(SOURCE_TOOLS).optional(),
        sessions_path: z.string().min(1).optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ source, sessions_path, overwrite }) =>
      withToolBundle(bundle, storePath, ensureStore, async (activeBundle) => {
        if (sessions_path && !source) {
          return {
            content: [
              {
                type: 'text',
                text: 'sessions_path requires source because providers use incompatible source layouts',
              },
            ],
            isError: true,
          }
        }

        if (!source && !sessions_path) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ mode: 'status', search_index: getSearchIndexStatuses(activeBundle) }, null, 2),
              },
            ],
          }
        }

        try {
          const result = await runCompileImports({
            bundle: activeBundle,
            providers: source ? [getCompileProvider(source)] : COMPILE_PROVIDERS,
            sessionsPath: sessions_path,
            overwrite,
          })
          const parquet = result.importedAny ? await exportCompileParquet({ storePath }) : null

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    mode: 'import',
                    providers: result.providers.map((provider) => ({
                      source: provider.source,
                      source_path: provider.sourcePath,
                      batch_id: provider.batchId,
                      counts: provider.counts,
                    })),
                    imported_any: result.importedAny,
                    tantivy: result.tantivy ? { indexed_doc_count: result.tantivy.indexedDocCount } : null,
                    tantivy_error: result.tantivyError,
                    fts5_error: result.fts5Error,
                    parquet: parquet
                      ? {
                          out_dir: parquet.outDir,
                          manifest_path: parquet.manifestPath,
                          table_count: parquet.tableCount,
                          files: parquet.files,
                          counts: parquet.counts,
                        }
                      : null,
                    search_index: getSearchIndexStatuses(activeBundle),
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        } catch (error) {
          return {
            content: [{ type: 'text', text: getErrorMessage(error) }],
            isError: true,
          }
        }
      }),
  )
}

async function withToolBundle<T>(
  fallbackBundle: Bundle,
  storePath: string,
  ensureStore: boolean,
  fn: (bundle: Bundle) => Promise<T> | T,
): Promise<T> {
  if (!ensureStore) {
    return await fn(fallbackBundle)
  }

  const bundle = await openOrInitBundle(storePath)
  try {
    return await fn(bundle)
  } finally {
    closeBundle(bundle)
  }
}

function registerProsaPrompts(server: McpServer): void {
  server.registerPrompt(
    'investigate_prior_work',
    {
      title: 'Investigate prior work',
      description:
        'Guide an agent through searching prosa for prior work on a topic, opening relevant sessions, and citing evidence.',
      argsSchema: {
        topic: z.string().min(1).describe('Topic, feature, error, command, or decision to investigate'),
      },
    },
    ({ topic }) => ({
      description: 'Search prosa for relevant prior work and answer with session evidence.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: INVESTIGATE_PRIOR_WORK_PROMPT.replace('{{topic}}', topic),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'find_file_history',
    {
      title: 'Find file history',
      description:
        'Guide an agent through finding sessions that touched a file/path and summarizing the relevant history.',
      argsSchema: {
        path: z.string().min(1).describe('File path, directory, or distinctive path suffix'),
      },
    },
    ({ path }) => ({
      description: 'Find sessions that touched a path and summarize the evidence.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: FIND_FILE_HISTORY_PROMPT.replace('{{path}}', path),
          },
        },
      ],
    }),
  )

  server.registerPrompt(
    'audit_tool_failures',
    {
      title: 'Audit tool failures',
      description: 'Guide an agent through finding failed tool calls and grouping them by likely cause.',
      argsSchema: {
        query: z.string().optional().describe('Optional topic, file, command, or error to narrow audit'),
      },
    },
    ({ query }) => ({
      description: 'Audit failed tool calls and cite operational evidence.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: AUDIT_TOOL_FAILURES_PROMPT.replace('{{query_clause}}', query ? ` related to: ${query}` : ''),
          },
        },
      ],
    }),
  )
}
