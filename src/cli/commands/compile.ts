import { Command } from 'commander';
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import {
  COMPILE_PROVIDERS,
  type CompileProviderConfig,
  type ProviderCompileSummary,
  exportCompileParquet,
  resolveCompilePath,
  runCompileImports,
} from '../../services/compile.js';
import { type CliLoggerOptions, createCliLogger } from '../logger.js';

export function compileCommand(): Command {
  const command = addCompileLogOptions(
    new Command('compile').description(
      'Import session histories from one agent CLI into the bundle.',
    ),
  );

  for (const provider of COMPILE_PROVIDERS) {
    command.addCommand(providerCompileCommand(provider));
  }

  command.action(() => {
    command.help({ error: true });
  });

  return command;
}

export function compileAllCommand(): Command {
  return addCompileLogOptions(new Command('compile-all'))
    .description('Import all agent CLI session histories using default source paths.')
    .option('--defer-index', 'skip immediate FTS5 updates; run `prosa index fts5` later')
    .action(async (options: CliLoggerOptions & { deferIndex?: boolean }) => {
      await runCompiles({
        providers: COMPILE_PROVIDERS,
        storePath: defaultBundlePath(),
        deferIndex: options.deferIndex ?? false,
        logOptions: options,
      });
    });
}

function providerCompileCommand(provider: CompileProviderConfig): Command {
  return addCompileLogOptions(new Command(provider.name))
    .description(provider.description)
    .option(
      '--sessions-path <path>',
      `${provider.pathHelp} (default: ${provider.defaultSessionsPath()})`,
      provider.defaultSessionsPath(),
    )
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--defer-index', 'skip immediate FTS5 updates; run `prosa index fts5` later')
    .action(
      async (
        options: {
          sessionsPath: string;
          store: string;
          deferIndex?: boolean;
        },
        command: Command,
      ) => {
        await runCompiles({
          providers: [provider],
          storePath: options.store,
          deferIndex: options.deferIndex ?? false,
          sessionsPath: options.sessionsPath,
          logOptions: command.optsWithGlobals() as CliLoggerOptions,
        });
      },
    );
}

function addCompileLogOptions(command: Command): Command {
  return command
    .option('--verbose', 'emit debug logs during compilation')
    .option('--json-logs', 'emit raw newline-delimited JSON logs instead of pretty logs');
}

async function runCompiles(options: {
  providers: CompileProviderConfig[];
  storePath: string;
  deferIndex: boolean;
  sessionsPath?: string;
  logOptions: CliLoggerOptions;
}): Promise<void> {
  const logger = createCliLogger(options.logOptions);
  const storePath = resolveCompilePath(options.storePath);
  logger.info({ store_path: storePath }, 'opening bundle');
  const bundle = await openBundle(storePath);
  let importedAny = false;
  try {
    const result = await runCompileImports({
      bundle,
      providers: options.providers,
      deferIndex: options.deferIndex,
      sessionsPath: options.sessionsPath,
      logger,
      onProviderComplete: printCounts,
      onTantivyComplete: (status) => {
        process.stdout.write(`tantivy: indexed ${status.indexedDocCount} docs\n`);
      },
    });
    importedAny = result.importedAny;
  } finally {
    closeBundle(bundle);
    logger.info({ store_path: storePath }, 'bundle closed');
  }

  // Parquet rebuild runs after the bundle is closed: exportBundleParquet
  // opens its own bundle handle and DuckDB attaches the SQLite file
  // directly, so we avoid any contention. As with Tantivy, failures are
  // logged but don't fail the compile — the user can re-run with
  // `prosa export parquet`.
  if (importedAny) {
    try {
      const result = await exportCompileParquet({ storePath, logger });
      process.stdout.write(`parquet: wrote ${result.tableCount} tables to ${result.outDir}\n`);
    } catch (error) {
      logger.error({ err: error }, 'parquet export failed; SQLite data is intact');
    }
  }
}

function printCounts(summary: ProviderCompileSummary): void {
  const c = summary.counts;
  process.stdout.write(
    `${summary.source} import: batch=${summary.batchId}\n` +
      `  source_files seen=${c.source_files_seen} imported=${c.source_files_imported} skipped=${c.source_files_skipped}\n` +
      `  sessions=${c.sessions} turns=${c.turns} messages=${c.messages} blocks=${c.content_blocks}\n` +
      `  events=${c.events} tool_calls=${c.tool_calls} tool_results=${c.tool_results}\n` +
      `  artifacts=${c.artifacts} edges=${c.edges} errors=${c.errors}\n`,
  );
}
