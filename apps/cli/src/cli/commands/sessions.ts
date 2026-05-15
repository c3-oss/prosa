import { countSessions, defaultBundlePath, listSessions } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { withBundle } from '../bundle.js'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../columns.js'
import { printRows } from '../output.js'
import { parseOutputFormat, parseSourceTool } from '../parsers.js'

type SessionCol =
  | 'start_ts'
  | 'end_ts'
  | 'source_tool'
  | 'session_id'
  | 'source_session_id'
  | 'parent_session_id'
  | 'is_subagent'
  | 'title'
  | 'cwd_initial'
  | 'git_branch_initial'
  | 'model_first'
  | 'model_last'
  | 'status'
  | 'timeline_confidence'
  | 'message_count'
  | 'tool_call_count'

const SESSION_COLUMNS: ColumnSet<SessionCol> = {
  default: ['start_ts', 'source_tool', 'session_id', 'model_last', 'message_count', 'tool_call_count', 'title'],
  all: [
    'start_ts',
    'end_ts',
    'source_tool',
    'session_id',
    'source_session_id',
    'parent_session_id',
    'is_subagent',
    'title',
    'cwd_initial',
    'git_branch_initial',
    'model_first',
    'model_last',
    'status',
    'timeline_confidence',
    'message_count',
    'tool_call_count',
  ],
  maxWidths: {
    session_id: 12,
    source_session_id: 12,
    parent_session_id: 12,
    title: 50,
    model_last: 25,
    model_first: 25,
    cwd_initial: 40,
    git_branch_initial: 25,
  },
  tail: new Set(['cwd_initial']),
}

/** Create the `prosa sessions` command and its count subcommand. */
export function sessionsCommand(): Command {
  const command = new Command('sessions')
    .description('List sessions in the bundle, with filters.')
    .enablePositionalOptions()
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini|hermes')
    .option('--since <iso>', 'sessions starting on/after this ISO timestamp')
    .option('--until <iso>', 'sessions starting before this ISO timestamp')
    .option('--limit <n>', 'maximum rows', '50')
    .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .option(
      '--columns <list>',
      `comma-separated columns to show (or 'default'|'all'); available: ${SESSION_COLUMNS.all.join(', ')}`,
    )
    .action(
      async (options: {
        store: string
        source?: string
        since?: string
        until?: string
        limit: string
        local: boolean
        outputFormat: string
        columns?: string
      }) => {
        const format = parseOutputFormat(options.outputFormat, 'table')
        const columns = resolveColumns(SESSION_COLUMNS, options.columns)
        const sourceTool = parseSourceTool(options.source)
        const authority = await resolveReadAuthorityOrFailClosed({
          commandName: 'prosa sessions',
          storePath: options.store,
          forceLocal: options.local,
          remoteSupported: true,
        })
        if (authority.kind === 'remote') {
          const remotePage = await authority.client.listSessions({
            limit: Number.parseInt(options.limit, 10),
            ...(sourceTool ? { sourceKinds: [sourceTool] } : {}),
            ...(options.since ? { since: options.since } : {}),
            ...(options.until ? { until: options.until } : {}),
          })
          const remoteShaped = remotePage.rows.map((row) => ({
            session_id: row.id,
            source_tool: row.sourceKind,
            title: row.title,
            start_ts: row.startedAt,
            end_ts: row.endedAt,
            message_count: row.messageCount,
            tool_call_count: row.toolCallCount,
            model_first: null,
            model_last: null,
            status: null,
            timeline_confidence: null,
            project_id: row.projectId,
          }))
          printRows(remoteShaped, {
            format,
            columns,
            maxColumnWidths: maxWidthsForColumns(SESSION_COLUMNS, columns),
            tailColumns: tailColumnsFor(SESSION_COLUMNS, columns),
            meta: { source: 'remote', server: authority.entry.url },
          })
          return
        }
        await withBundle(options.store, (bundle) => {
          const rows = listSessions(bundle, {
            sourceTool,
            sinceIso: options.since,
            untilIso: options.until,
            limit: Number.parseInt(options.limit, 10),
          })

          printRows(rows, {
            format,
            columns,
            maxColumnWidths: maxWidthsForColumns(SESSION_COLUMNS, columns),
            tailColumns: tailColumnsFor(SESSION_COLUMNS, columns),
          })
        })
      },
    )

  command.addCommand(
    new Command('count')
      .description('Count sessions in the bundle, with filters.')
      .option('--store <path>', 'bundle directory', defaultBundlePath())
      .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini|hermes')
      .option('--since <iso>', 'sessions starting on/after this ISO timestamp')
      .option('--until <iso>', 'sessions starting before this ISO timestamp')
      .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
      .action(
        async (options: {
          store: string
          source?: string
          since?: string
          until?: string
          local: boolean
        }) => {
          const sourceTool = parseSourceTool(options.source)
          const authority = await resolveReadAuthorityOrFailClosed({
            commandName: 'prosa sessions count',
            storePath: options.store,
            forceLocal: options.local,
            remoteSupported: true,
          })
          if (authority.kind === 'remote') {
            const result = await authority.client.countSessions({
              ...(sourceTool ? { sourceKinds: [sourceTool] } : {}),
              ...(options.since ? { since: options.since } : {}),
              ...(options.until ? { until: options.until } : {}),
            })
            process.stdout.write(`${result.count}\n`)
            return
          }
          await withBundle(options.store, (bundle) => {
            const count = countSessions(bundle, {
              sourceTool,
              sinceIso: options.since,
              untilIso: options.until,
            })
            process.stdout.write(`${count}\n`)
          })
        },
      ),
  )

  return command
}
