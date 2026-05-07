import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bundle } from '../core/bundle.js';
import { SOURCE_TOOLS, type SourceTool } from '../core/domain/types.js';
import { getErrorMessage } from '../core/errors.js';
import { clampLimit } from '../core/limits.js';
import {
  COMPILE_PROVIDERS,
  exportCompileParquet,
  getCompileProvider,
  runCompileImports,
} from '../services/compile.js';
import { exportSessionMarkdown } from '../services/export/markdown.js';
import { type SearchEngine, getSearchIndexStatuses } from '../services/indexing.js';
import { searchFullText } from '../services/search.js';
import { getSession, listSessions } from '../services/sessions.js';
import {
  AUDIT_TOOL_FAILURES_PROMPT,
  FIND_FILE_HISTORY_PROMPT,
  INVESTIGATE_PRIOR_WORK_PROMPT,
} from './guidance.js';

export interface ProsaToolOptions {
  searchEngine?: SearchEngine;
  storePath?: string;
}

/**
 * Register every prosa MCP tool on `server`. Most tools are read-only; compile
 * is intentionally mutating and reuses the same import services as the CLI.
 */
export function registerProsaTools(
  server: McpServer,
  bundle: Bundle,
  options: ProsaToolOptions = {},
): void {
  const searchEngine = options.searchEngine ?? 'fts5';
  const storePath = options.storePath ?? bundle.path;
  registerProsaPrompts(server);

  server.registerTool(
    'compile',
    {
      title: 'Compile sessions',
      description:
        'Import local agent session histories into the active prosa bundle. With no input, compiles all providers from default paths. With source, compiles that provider; sessions_path may override that provider path.',
      inputSchema: {
        source: z.enum(SOURCE_TOOLS).optional(),
        sessions_path: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ source, sessions_path }) => {
      if (sessions_path && !source) {
        return {
          content: [
            {
              type: 'text',
              text: 'sessions_path requires source because providers use incompatible source layouts',
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await runCompileImports({
          bundle,
          providers: source ? [getCompileProvider(source)] : COMPILE_PROVIDERS,
          deferIndex: false,
          sessionsPath: sessions_path,
        });
        const parquet = result.importedAny ? await exportCompileParquet({ storePath }) : null;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  providers: result.providers.map((provider) => ({
                    source: provider.source,
                    source_path: provider.sourcePath,
                    batch_id: provider.batchId,
                    counts: provider.counts,
                  })),
                  imported_any: result.importedAny,
                  tantivy: result.tantivy
                    ? { indexed_doc_count: result.tantivy.indexedDocCount }
                    : null,
                  tantivy_error: result.tantivyError,
                  parquet: parquet
                    ? {
                        out_dir: parquet.outDir,
                        manifest_path: parquet.manifestPath,
                        table_count: parquet.tableCount,
                        files: parquet.files,
                        counts: parquet.counts,
                      }
                    : null,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: getErrorMessage(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description:
        'List recent sessions when you need candidates by source/date before deeper inspection. Next step: call get_session for relevant session_id values.',
      inputSchema: {
        source: z.enum(SOURCE_TOOLS).optional(),
        since: z.string().optional().describe('ISO timestamp lower bound (inclusive)'),
        until: z.string().optional().describe('ISO timestamp upper bound (exclusive)'),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const rows = listSessions(bundle, {
        sourceTool: input.source,
        sinceIso: input.since,
        untilIso: input.until,
        limit: input.limit ?? 50,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_session',
    {
      title: 'Get session detail',
      description:
        'Open one session and return metadata plus timeline events. Use this after search_sessions, list_sessions, find_touched_files, or list_tool_calls before making evidence-backed claims.',
      inputSchema: {
        session_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ session_id }) => {
      const detail = getSession(bundle, session_id);
      if (!detail) {
        return {
          content: [{ type: 'text', text: `session not found: ${session_id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
      };
    },
  );

  server.registerTool(
    'search_sessions',
    {
      title: 'Full-text search',
      description: `Search messages, commands, paths, and result previews using the server-selected ${searchEngine} engine. Start here for open-ended questions with 2-5 concrete terms, then call get_session for relevant hits.`,
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional().default(50),
        raw: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit, raw }) => {
      const hits = searchFullText(bundle, { query, limit: limit ?? 50, raw, engine: searchEngine });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { query, engine: searchEngine, count: hits.length, hits },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'export_session_markdown',
    {
      title: 'Export session as Markdown',
      description:
        'Render a selected session into a readable transcript. Use only after get_session confirms relevance; this can return much more context than snippets.',
      inputSchema: {
        session_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ session_id }) => {
      try {
        const md = await exportSessionMarkdown(bundle, session_id);
        return { content: [{ type: 'text', text: md }] };
      } catch (error) {
        return {
          content: [{ type: 'text', text: getErrorMessage(error) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'list_tool_calls',
    {
      title: 'List tool calls',
      description:
        'Audit commands and tool usage by tool name, canonical type, error status, or session. Use this for failed commands, shell history, patches, and operational evidence; then open relevant sessions with get_session.',
      inputSchema: {
        tool_name: z.string().optional(),
        canonical_type: z
          .enum([
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
          ])
          .optional(),
        session_id: z.string().optional(),
        errors_only: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ tool_name, canonical_type, session_id, errors_only, limit }) => {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (tool_name) {
        conds.push('tc.tool_name = ?');
        params.push(tool_name);
      }
      if (canonical_type) {
        conds.push('tc.canonical_tool_type = ?');
        params.push(canonical_type);
      }
      if (session_id) {
        conds.push('tc.session_id = ?');
        params.push(session_id);
      }
      if (errors_only) {
        conds.push('(tr.is_error = 1 OR tc.status = ?)');
        params.push('error');
      }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      const sql = `
        SELECT tc.tool_call_id, tc.session_id, tc.tool_name, tc.canonical_tool_type,
               tc.command, tc.path, tc.status, tc.timestamp_start,
               tr.is_error, tr.exit_code, tr.preview
          FROM tool_calls tc
          LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id
          ${where}
         ORDER BY tc.timestamp_start DESC
         LIMIT ${clampLimit(limit, { max: 500, fallback: 100 })}
      `;
      const rows = bundle.db.prepare(sql).all(...params);
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    'find_touched_files',
    {
      title: 'Find sessions that touched a file',
      description:
        'Find sessions with tool calls or artifacts whose path contains `path_substring`. Start here for file-history questions, then open returned sessions with get_session.',
      inputSchema: {
        path_substring: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional().default(100),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ path_substring, limit }) => {
      const sql = `
        SELECT tc.session_id, tc.tool_name, tc.canonical_tool_type, tc.path,
               tc.timestamp_start, tc.command
          FROM tool_calls tc
         WHERE tc.path IS NOT NULL AND tc.path LIKE ?
         UNION ALL
        SELECT a.session_id AS session_id, NULL AS tool_name, NULL AS canonical_tool_type,
               a.path, a.created_ts AS timestamp_start, NULL AS command
          FROM artifacts a
         WHERE a.path IS NOT NULL AND a.path LIKE ?
         ORDER BY timestamp_start DESC
         LIMIT ${clampLimit(limit, { max: 500, fallback: 100 })}
      `;
      const like = `%${path_substring}%`;
      const rows = bundle.db.prepare(sql).all(like, like);
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    },
  );

  server.registerTool(
    'get_artifact',
    {
      title: 'Get artifact bytes/text',
      description:
        'Retrieve full text for an artifact_id found in a session or export. Use this for detailed diffs or large tool outputs after identifying the artifact; binary artifacts return a placeholder.',
      inputSchema: {
        artifact_id: z.string().min(1),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ artifact_id }) => {
      const row = bundle.db
        .prepare<
          [string],
          { text_object_id: string | null; object_id: string | null; mime_type: string | null }
        >(`SELECT text_object_id, object_id, mime_type FROM artifacts WHERE artifact_id = ?`)
        .get(artifact_id);
      if (!row) {
        return {
          content: [{ type: 'text', text: `artifact not found: ${artifact_id}` }],
          isError: true,
        };
      }
      const objectId = row.text_object_id ?? row.object_id;
      if (!objectId) {
        return { content: [{ type: 'text', text: '[no content stored]' }] };
      }
      try {
        const { getText } = await import('../core/cas/index.js');
        const text = await getText(bundle, objectId);
        return { content: [{ type: 'text', text }] };
      } catch {
        return { content: [{ type: 'text', text: `[binary artifact: ${objectId}]` }] };
      }
    },
  );

  server.registerTool(
    'index_status',
    {
      title: 'Search index status',
      description:
        'Show whether derived search indexes are ready, stale, missing, building, or failed. Use when search results are unexpectedly empty or when choosing between FTS5 and Tantivy.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const rows = getSearchIndexStatuses(bundle);
      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    },
  );
}

function registerProsaPrompts(server: McpServer): void {
  server.registerPrompt(
    'investigate_prior_work',
    {
      title: 'Investigate prior work',
      description:
        'Guide an agent through searching prosa for prior work on a topic, opening relevant sessions, and citing evidence.',
      argsSchema: {
        topic: z
          .string()
          .min(1)
          .describe('Topic, feature, error, command, or decision to investigate'),
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
  );

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
  );

  server.registerPrompt(
    'audit_tool_failures',
    {
      title: 'Audit tool failures',
      description:
        'Guide an agent through finding failed tool calls and grouping them by likely cause.',
      argsSchema: {
        query: z
          .string()
          .optional()
          .describe('Optional topic, file, command, or error to narrow audit'),
      },
    },
    ({ query }) => ({
      description: 'Audit failed tool calls and cite operational evidence.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: AUDIT_TOOL_FAILURES_PROMPT.replace(
              '{{query_clause}}',
              query ? ` related to: ${query}` : '',
            ),
          },
        },
      ],
    }),
  );
}
