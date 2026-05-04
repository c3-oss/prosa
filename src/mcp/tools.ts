import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bundle } from '../core/bundle.js';
import type { SourceTool } from '../core/domain/types.js';
import { exportSessionMarkdown } from '../services/export/markdown.js';
import { searchFullText } from '../services/search.js';
import { getSession, listSessions } from '../services/sessions.js';

/**
 * Register every prosa MCP tool on `server`. All tools are read-only and
 * idempotent; nothing here mutates the bundle. The handlers reuse the same
 * service functions the CLI calls, so behavior stays consistent across
 * surfaces.
 */
export function registerProsaTools(server: McpServer, bundle: Bundle): void {
  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description:
        'List sessions in the prosa store, optionally filtered by source tool, date range, or substring on cwd/title. Returns at most `limit` rows ordered by most recent start.',
      inputSchema: {
        source: z.enum(['cursor', 'codex', 'claude', 'gemini']).optional(),
        since: z.string().optional().describe('ISO timestamp lower bound (inclusive)'),
        until: z.string().optional().describe('ISO timestamp upper bound (exclusive)'),
        limit: z.number().int().min(1).max(500).optional().default(50),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const rows = listSessions(bundle, {
        sourceTool: input.source as SourceTool | undefined,
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
        'Return metadata plus the timeline of events for one session. Use `list_sessions` first to discover ids.',
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
      description:
        'FTS5 search over messages, tool calls and tool result previews. Punctuation in queries is auto-quoted; pass `raw: true` to use raw FTS5 MATCH syntax (OR, NEAR, prefixes).',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional().default(50),
        raw: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit, raw }) => {
      const hits = searchFullText(bundle, { query, limit: limit ?? 50, raw });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ query, count: hits.length, hits }, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    'export_session_markdown',
    {
      title: 'Export session as Markdown',
      description: 'Render a single session into a human-readable Markdown transcript.',
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
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
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
        'List tool calls in the bundle, filtered by tool name, canonical type, error status, or session id. Use this to audit what shell commands ran, which files were edited, etc.',
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
         LIMIT ${Math.max(1, Math.min(500, limit ?? 100))}
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
        'Find every tool call or artifact whose file path matches `path_substring`. Useful for "what conversations touched src/foo.ts?".',
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
         LIMIT ${Math.max(1, Math.min(500, limit ?? 100))}
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
        'Retrieve the text content of an artifact (diff, tool output, attachment) by its prosa artifact_id. Returns `[base64]` placeholder for binary artifacts.',
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
}
