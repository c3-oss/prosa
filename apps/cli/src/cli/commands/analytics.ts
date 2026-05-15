import path from 'node:path'
import {
  type AnalyticsReport,
  type AnalyticsReportFilters,
  defaultBundlePath,
  exportBundleParquet,
  runAnalyticsReport,
} from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { asCliBundleOpenError, withBundle } from '../bundle.js'
import { type ColumnSet, maxWidthsForColumns, resolveColumns, tailColumnsFor } from '../columns.js'
import { printRows } from '../output.js'
import { parseOutputFormat, parseSourceTool } from '../parsers.js'

interface AnalyticsCliOptions {
  store: string
  parquetDir?: string
  refresh?: boolean
  source?: string
  since?: string
  until?: string
  limit: string
  outputFormat: string
  columns?: string
  toolName?: string
  canonicalType?: string
  errorsOnly?: boolean
  category?: string
  model?: string
  project?: string
}

// Column surfaces match the columns selected by buildAnalyticsSql in
// src/services/analytics.ts. `default` is the curated set that fits a ~120-
// column terminal; `all` keeps every column the SQL returns so power users
// can opt back in via `--columns all` or pick specific extras by name.

type SessionsCol =
  | 'start_ts'
  | 'source_tool'
  | 'project_name'
  | 'source_file_path'
  | 'session_id'
  | 'source_session_id'
  | 'model_last'
  | 'duration_seconds'
  | 'message_count'
  | 'tool_call_count'
  | 'tool_result_count'
  | 'tool_error_count'
  | 'tool_duration_ms'
  | 'timeline_confidence'
  | 'title'

const SESSIONS_COLUMNS: ColumnSet<SessionsCol> = {
  default: [
    'start_ts',
    'source_tool',
    'project_name',
    'model_last',
    'duration_seconds',
    'message_count',
    'tool_call_count',
    'tool_error_count',
    'title',
  ],
  all: [
    'start_ts',
    'source_tool',
    'project_name',
    'source_file_path',
    'session_id',
    'source_session_id',
    'model_last',
    'duration_seconds',
    'message_count',
    'tool_call_count',
    'tool_result_count',
    'tool_error_count',
    'tool_duration_ms',
    'timeline_confidence',
    'title',
  ],
  maxWidths: {
    project_name: 30,
    model_last: 25,
    title: 40,
    session_id: 12,
    source_session_id: 12,
    source_file_path: 40,
  },
  tail: new Set(['source_file_path']),
}

type ToolsCol =
  | 'tool_name'
  | 'canonical_tool_type'
  | 'source_tool'
  | 'project_name'
  | 'call_count'
  | 'error_count'
  | 'avg_result_duration_ms'
  | 'latest_ts'

const TOOLS_COLUMNS: ColumnSet<ToolsCol> = {
  default: [
    'tool_name',
    'canonical_tool_type',
    'source_tool',
    'project_name',
    'call_count',
    'error_count',
    'avg_result_duration_ms',
    'latest_ts',
  ],
  all: [
    'tool_name',
    'canonical_tool_type',
    'source_tool',
    'project_name',
    'call_count',
    'error_count',
    'avg_result_duration_ms',
    'latest_ts',
  ],
  maxWidths: {
    tool_name: 30,
    project_name: 30,
    canonical_tool_type: 20,
  },
}

type ErrorsCol =
  | 'timestamp'
  | 'error_category'
  | 'source_tool'
  | 'project_name'
  | 'session_id'
  | 'tool_name'
  | 'status'
  | 'exit_code'
  | 'message'
  | 'preview'

const ERRORS_COLUMNS: ColumnSet<ErrorsCol> = {
  default: [
    'timestamp',
    'error_category',
    'source_tool',
    'project_name',
    'tool_name',
    'status',
    'exit_code',
    'preview',
  ],
  all: [
    'timestamp',
    'error_category',
    'source_tool',
    'project_name',
    'session_id',
    'tool_name',
    'status',
    'exit_code',
    'message',
    'preview',
  ],
  maxWidths: {
    project_name: 30,
    tool_name: 25,
    preview: 80,
    message: 80,
    session_id: 12,
  },
}

type ModelsCol =
  | 'model'
  | 'source_tool'
  | 'project_name'
  | 'session_count'
  | 'turn_count'
  | 'message_count'
  | 'observation_count'
  | 'first_seen_ts'
  | 'last_seen_ts'

const MODELS_COLUMNS: ColumnSet<ModelsCol> = {
  default: [
    'model',
    'source_tool',
    'project_name',
    'session_count',
    'turn_count',
    'message_count',
    'observation_count',
    'first_seen_ts',
    'last_seen_ts',
  ],
  all: [
    'model',
    'source_tool',
    'project_name',
    'session_count',
    'turn_count',
    'message_count',
    'observation_count',
    'first_seen_ts',
    'last_seen_ts',
  ],
  maxWidths: {
    model: 30,
    project_name: 30,
  },
}

type ProjectsCol =
  | 'latest_session_ts'
  | 'source_tool'
  | 'project_name'
  | 'project_path'
  | 'session_count'
  | 'message_count'
  | 'tool_call_count'
  | 'tool_error_count'
  | 'low_confidence_session_count'

const PROJECTS_COLUMNS: ColumnSet<ProjectsCol> = {
  default: [
    'latest_session_ts',
    'source_tool',
    'project_name',
    'session_count',
    'message_count',
    'tool_call_count',
    'tool_error_count',
    'low_confidence_session_count',
  ],
  all: [
    'latest_session_ts',
    'source_tool',
    'project_name',
    'project_path',
    'session_count',
    'message_count',
    'tool_call_count',
    'tool_error_count',
    'low_confidence_session_count',
  ],
  maxWidths: {
    project_name: 40,
    project_path: 40,
  },
  tail: new Set(['project_path']),
}

const COLUMN_SETS: Record<AnalyticsReport, ColumnSet<string>> = {
  sessions: SESSIONS_COLUMNS,
  tools: TOOLS_COLUMNS,
  errors: ERRORS_COLUMNS,
  models: MODELS_COLUMNS,
  projects: PROJECTS_COLUMNS,
}

/** Create the `prosa analytics` command group and its built-in report subcommands. */
export function analyticsCommand(): Command {
  const command = new Command('analytics').description('Run high-level analytics reports over exported Parquet files.')

  command.addCommand(reportCommand('sessions', 'Summarize sessions by source, project and model.'))
  command.addCommand(reportCommand('tools', 'Summarize tool usage, status, duration and errors.'))
  command.addCommand(reportCommand('errors', 'List import errors, failed tool results and uncertainties.'))
  command.addCommand(reportCommand('models', 'Summarize model usage by source, project and time.'))
  command.addCommand(reportCommand('projects', 'Summarize project activity and operational counts.'))

  return command
}

/** Create one report subcommand with filters and column controls appropriate to the report. */
function reportCommand(report: AnalyticsReport, description: string): Command {
  const command = addCommonOptions(new Command(report).description(description))

  if (report === 'tools') {
    command
      .option('--tool-name <name>', 'filter by exact tool name')
      .option('--canonical-type <type>', 'filter by canonical tool type')
      .option('--errors-only', 'only include tool calls with errors')
  }
  if (report === 'errors') {
    command
      .option('--tool-name <name>', 'filter by exact tool name')
      .option('--category <category>', 'filter by error category')
  }
  if (report === 'models') {
    command.option('--model <model>', 'filter by exact model name')
  }
  if (report === 'projects') {
    command.option('--project <text>', 'filter by project id, name, or path substring')
  }
  if (report === 'sessions') {
    command.option('--project <text>', 'filter by project id, name, or path substring')
  }

  const set = COLUMN_SETS[report]
  command.option(
    '--columns <list>',
    `comma-separated columns to show (or 'default'|'all'); available: ${set.all.join(', ')}`,
  )

  return command.action(async (options: AnalyticsCliOptions) => {
    const format = parseOutputFormat(options.outputFormat, 'table')
    const parquetDir = await resolveParquetDir(options)
    const filters = buildFilters(options)
    const result = await runAnalyticsReport({ parquetDir, report, filters })
    const columns = resolveColumns(set, options.columns)

    printRows(result.rows, {
      format,
      columns,
      maxColumnWidths: maxWidthsForColumns(set, columns),
      tailColumns: tailColumnsFor(set, columns),
      meta: { report, count: result.rows.length },
    })
  })
}

/** Add filters and output options shared by all analytics report commands. */
function addCommonOptions(command: Command): Command {
  return command
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--parquet-dir <path>', 'Parquet directory (default: <store>/parquet)')
    .option('--refresh', 'export Parquet before running the report')
    .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini|hermes')
    .option('--since <iso>', 'lower timestamp bound (inclusive)')
    .option('--until <iso>', 'upper timestamp bound (exclusive)')
    .option('--limit <n>', 'maximum rows', '50')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
}

/** Resolve or refresh the Parquet directory used as the analytics query source. */
async function resolveParquetDir(options: AnalyticsCliOptions): Promise<string> {
  const storePath = path.resolve(options.store)
  const outDir = options.parquetDir ? path.resolve(options.parquetDir) : undefined
  if (options.refresh) {
    const result = await exportBundleParquet({ bundlePath: storePath, outDir }).catch((error: unknown) => {
      throw asCliBundleOpenError(error)
    })
    return result.outDir
  }

  return outDir ?? (await withBundle(storePath, (bundle) => bundle.paths.parquet))
}

/** Convert raw CLI option strings into analytics service filters. */
function buildFilters(options: AnalyticsCliOptions): AnalyticsReportFilters {
  return {
    source: parseSourceTool(options.source),
    since: options.since,
    until: options.until,
    limit: Number.parseInt(options.limit, 10),
    toolName: options.toolName,
    canonicalType: options.canonicalType,
    errorsOnly: options.errorsOnly,
    category: options.category,
    model: options.model,
    project: options.project,
  }
}
