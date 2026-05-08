import path from 'node:path';
import { Command } from 'commander';
import { defaultBundlePath } from '../../core/bundle.js';
import {
  type AnalyticsReport,
  type AnalyticsReportFilters,
  runAnalyticsReport,
} from '../../services/analytics.js';
import { exportBundleParquet } from '../../services/export/parquet.js';
import { withBundle } from '../bundle.js';
import { printRows } from '../output.js';
import { parseOutputFormat, parseSourceTool } from '../parsers.js';

interface AnalyticsCliOptions {
  store: string;
  parquetDir?: string;
  refresh?: boolean;
  source?: string;
  since?: string;
  until?: string;
  limit: string;
  outputFormat: string;
  toolName?: string;
  canonicalType?: string;
  errorsOnly?: boolean;
  category?: string;
  model?: string;
  project?: string;
}

export function analyticsCommand(): Command {
  const command = new Command('analytics').description(
    'Run high-level analytics reports over exported Parquet files.',
  );

  command.addCommand(reportCommand('sessions', 'Summarize sessions by source, project and model.'));
  command.addCommand(reportCommand('tools', 'Summarize tool usage, status, duration and errors.'));
  command.addCommand(
    reportCommand('errors', 'List import errors, failed tool results and uncertainties.'),
  );
  command.addCommand(reportCommand('models', 'Summarize model usage by source, project and time.'));
  command.addCommand(
    reportCommand('projects', 'Summarize project activity and operational counts.'),
  );

  return command;
}

function reportCommand(report: AnalyticsReport, description: string): Command {
  const command = addCommonOptions(new Command(report).description(description));

  if (report === 'tools') {
    command
      .option('--tool-name <name>', 'filter by exact tool name')
      .option('--canonical-type <type>', 'filter by canonical tool type')
      .option('--errors-only', 'only include tool calls with errors');
  }
  if (report === 'errors') {
    command
      .option('--tool-name <name>', 'filter by exact tool name')
      .option('--category <category>', 'filter by error category');
  }
  if (report === 'models') {
    command.option('--model <model>', 'filter by exact model name');
  }
  if (report === 'projects') {
    command.option('--project <text>', 'filter by project id, name, or path substring');
  }
  if (report === 'sessions') {
    command.option('--project <text>', 'filter by project id, name, or path substring');
  }

  return command.action(async (options: AnalyticsCliOptions) => {
    const format = parseOutputFormat(options.outputFormat, 'table');
    const parquetDir = await resolveParquetDir(options);
    const filters = buildFilters(options);
    const result = await runAnalyticsReport({ parquetDir, report, filters });

    printRows(result.rows, {
      format,
      columns: result.columns,
      meta: { report, count: result.rows.length },
    });
  });
}

function addCommonOptions(command: Command): Command {
  return command
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--parquet-dir <path>', 'Parquet directory (default: <store>/parquet)')
    .option('--refresh', 'export Parquet before running the report')
    .option('--source <tool>', 'filter by source tool: cursor|codex|claude|gemini')
    .option('--since <iso>', 'lower timestamp bound (inclusive)')
    .option('--until <iso>', 'upper timestamp bound (exclusive)')
    .option('--limit <n>', 'maximum rows', '50')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table');
}

async function resolveParquetDir(options: AnalyticsCliOptions): Promise<string> {
  const storePath = path.resolve(options.store);
  const outDir = options.parquetDir ? path.resolve(options.parquetDir) : undefined;
  if (options.refresh) {
    const result = await exportBundleParquet({ bundlePath: storePath, outDir });
    return result.outDir;
  }

  return outDir ?? (await withBundle(storePath, (bundle) => bundle.paths.parquet));
}

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
  };
}
