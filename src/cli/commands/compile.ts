import { Command } from 'commander'
import { closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js'
import {
  COMPILE_PROVIDERS,
  type CompileProviderConfig,
  exportCompileParquet,
  resolveCompilePath,
  runCompileImports,
} from '../../services/compile.js'
import { type CliLoggerOptions, createCliLogger } from '../logger.js'

export function compileCommand(): Command {
  const command = addCompileLogOptions(
    new Command('compile').description('Import session histories from one agent CLI into the bundle.'),
  )

  for (const provider of COMPILE_PROVIDERS) {
    command.addCommand(providerCompileCommand(provider))
  }

  command.action(() => {
    command.help({ error: true })
  })

  return command
}

export function compileAllCommand(): Command {
  return addCompileLogOptions(new Command('compile-all'))
    .description('Import all agent CLI session histories using default source paths.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option(
      '--overwrite',
      'force a full rebuild of derived indexes after import (Tantivy from scratch; FTS5 and Parquet are always full)',
      false,
    )
    .action(async (options: CliLoggerOptions & { store: string; overwrite: boolean }) => {
      await runCompiles({
        providers: COMPILE_PROVIDERS,
        storePath: options.store,
        overwrite: options.overwrite,
        logOptions: options,
      })
    })
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
    .option(
      '--overwrite',
      'force a full rebuild of derived indexes after import (Tantivy from scratch; FTS5 and Parquet are always full)',
      false,
    )
    .action(
      async (
        options: {
          sessionsPath: string
          store: string
          overwrite: boolean
        },
        command: Command,
      ) => {
        await runCompiles({
          providers: [provider],
          storePath: options.store,
          sessionsPath: options.sessionsPath,
          overwrite: options.overwrite,
          logOptions: command.optsWithGlobals() as CliLoggerOptions,
        })
      },
    )
}

function addCompileLogOptions(command: Command): Command {
  return command
    .option('--verbose', 'emit debug logs during compilation')
    .option('--json-logs', 'emit raw newline-delimited JSON logs instead of pretty logs')
}

async function runCompiles(options: {
  providers: CompileProviderConfig[]
  storePath: string
  sessionsPath?: string
  overwrite?: boolean
  logOptions: CliLoggerOptions
}): Promise<void> {
  const logger = createCliLogger(options.logOptions)
  const storePath = resolveCompilePath(options.storePath)
  logger.info({ store_path: storePath }, 'opening bundle')
  const bundle = await openBundle(storePath)
  let importedAny = false
  try {
    const result = await runCompileImports({
      bundle,
      providers: options.providers,
      sessionsPath: options.sessionsPath,
      overwrite: options.overwrite,
      logger,
    })
    importedAny = result.importedAny
  } finally {
    closeBundle(bundle)
    logger.info({ store_path: storePath }, 'bundle closed')
  }

  // Parquet rebuild runs after the bundle is closed: exportBundleParquet
  // opens its own bundle handle and DuckDB attaches the SQLite file
  // directly, so we avoid any contention. As with Tantivy, failures are
  // logged but don't fail the compile — the user can re-run with
  // `prosa export parquet`.
  const shouldExportParquet = importedAny || options.overwrite === true
  if (shouldExportParquet) {
    try {
      const result = await exportCompileParquet({ storePath, logger })
      logger.info({ table_count: result.tableCount, out_dir: result.outDir }, 'parquet export finished')
    } catch (error) {
      logger.error({ err: error }, 'parquet export failed; SQLite data is intact')
    }
  }
}
