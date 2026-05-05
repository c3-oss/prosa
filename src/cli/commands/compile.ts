import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { type Bundle, closeBundle, defaultBundlePath, openBundle } from '../../core/bundle.js';
import type { SourceTool } from '../../core/domain/types.js';
import type { ImportBatch, ImportCounts } from '../../core/ingest/batch.js';
import { compileClaude } from '../../importers/claude/index.js';
import { compileCodex } from '../../importers/codex/index.js';
import type { CompileOptions } from '../../importers/compile-options.js';
import { compileCursor } from '../../importers/cursor/index.js';
import { compileGemini } from '../../importers/gemini/index.js';
import {
  disableFts5Triggers,
  enableFts5Triggers,
  markIndexesAfterImport,
} from '../../services/indexing.js';
import { createCliLogger } from '../logger.js';

interface CompileResult {
  batch: ImportBatch;
  counts: ImportCounts;
}

interface ProviderConfig {
  name: SourceTool;
  description: string;
  pathHelp: string;
  defaultSessionsPath: () => string;
  compile: (bundle: Bundle, root: string, options?: CompileOptions) => Promise<CompileResult>;
}

interface CompileLogOptions {
  verbose?: boolean;
  jsonLogs?: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    name: 'codex',
    description: 'Import Codex CLI session histories into the bundle.',
    pathHelp: 'root of Codex CLI sessions',
    defaultSessionsPath: () => path.join(os.homedir(), '.codex', 'sessions'),
    compile: compileCodex,
  },
  {
    name: 'claude',
    description: 'Import Claude Code project histories into the bundle.',
    pathHelp: 'root of Claude Code projects',
    defaultSessionsPath: () => path.join(os.homedir(), '.claude', 'projects'),
    compile: compileClaude,
  },
  {
    name: 'gemini',
    description: 'Import Gemini CLI session histories into the bundle.',
    pathHelp: 'root of Gemini CLI tmp dir',
    defaultSessionsPath: () => path.join(os.homedir(), '.gemini', 'tmp'),
    compile: compileGemini,
  },
  {
    name: 'cursor',
    description: 'Import Cursor agent stores into the bundle.',
    pathHelp: 'root of Cursor agent stores',
    defaultSessionsPath: () => path.join(os.homedir(), '.cursor', 'chats'),
    compile: compileCursor,
  },
];

export function compileCommand(): Command {
  const command = addCompileLogOptions(
    new Command('compile').description(
      'Import session histories from one agent CLI into the bundle.',
    ),
  );

  for (const provider of PROVIDERS) {
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
    .action(async (options: CompileLogOptions) => {
      await runCompiles({
        providers: PROVIDERS,
        storePath: defaultBundlePath(),
        deferIndex: false,
        logOptions: options,
      });
    });
}

function providerCompileCommand(provider: ProviderConfig): Command {
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
          deferIndex: options.deferIndex === true,
          sessionsPath: options.sessionsPath,
          logOptions: command.optsWithGlobals() as CompileLogOptions,
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
  providers: ProviderConfig[];
  storePath: string;
  deferIndex: boolean;
  sessionsPath?: string;
  logOptions: CompileLogOptions;
}): Promise<void> {
  const logger = createCliLogger(options.logOptions);
  const storePath = resolvePath(options.storePath);
  logger.info({ store_path: storePath }, 'opening bundle');
  const bundle = await openBundle(storePath);
  let importedAny = false;
  try {
    if (options.deferIndex) {
      logger.info('disabling FTS5 triggers for deferred indexing');
      disableFts5Triggers(bundle);
    }

    for (const provider of options.providers) {
      const sourcePath = resolvePath(options.sessionsPath ?? provider.defaultSessionsPath());
      const providerLogger = logger.child({
        source_tool: provider.name,
        source_path: sourcePath,
      });
      providerLogger.info('starting compile');
      const r = await provider.compile(bundle, sourcePath, { logger: providerLogger });
      importedAny ||= r.counts.source_files_imported > 0;
      providerLogger.info(
        {
          batch_id: r.batch.batch_id,
          counts: r.counts,
        },
        'compile finished',
      );
      printCounts(provider.name, r.batch.batch_id, r.counts);
    }

    logger.info({ changed: importedAny, fts5_deferred: options.deferIndex }, 'marking indexes');
    markIndexesAfterImport(bundle, {
      changed: importedAny,
      fts5Deferred: options.deferIndex,
    });
  } finally {
    if (options.deferIndex) {
      logger.info('re-enabling FTS5 triggers');
      enableFts5Triggers(bundle);
    }
    closeBundle(bundle);
    logger.info({ store_path: storePath }, 'bundle closed');
  }
}

function resolvePath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

function printCounts(label: string, batchId: string, c: ImportCounts): void {
  process.stdout.write(
    `${label} import: batch=${batchId}\n` +
      `  source_files seen=${c.source_files_seen} imported=${c.source_files_imported} skipped=${c.source_files_skipped}\n` +
      `  sessions=${c.sessions} turns=${c.turns} messages=${c.messages} blocks=${c.content_blocks}\n` +
      `  events=${c.events} tool_calls=${c.tool_calls} tool_results=${c.tool_results}\n` +
      `  artifacts=${c.artifacts} edges=${c.edges} errors=${c.errors}\n`,
  );
}
