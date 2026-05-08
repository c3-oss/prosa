import os from 'node:os';
import path from 'node:path';
import type { Bundle } from '../core/bundle.js';
import type { SourceTool } from '../core/domain/types.js';
import { getErrorMessage } from '../core/errors.js';
import type { ImportBatch, ImportCounts } from '../core/ingest/batch.js';
import { compileClaude } from '../importers/claude/index.js';
import { compileCodex } from '../importers/codex/index.js';
import type { CompileLogger, CompileOptions } from '../importers/compile-options.js';
import { compileCursor } from '../importers/cursor/index.js';
import { compileGemini } from '../importers/gemini/index.js';
import { exportBundleParquet } from './export/parquet.js';
import {
  disableFts5Triggers,
  enableFts5Triggers,
  markIndexesAfterImport,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from './indexing.js';

interface CompileResult {
  batch: ImportBatch;
  counts: ImportCounts;
}

export interface CompileProviderConfig {
  name: SourceTool;
  description: string;
  pathHelp: string;
  defaultSessionsPath: () => string;
  compile: (bundle: Bundle, root: string, options?: CompileOptions) => Promise<CompileResult>;
}

export interface ProviderCompileSummary {
  source: SourceTool;
  sourcePath: string;
  batchId: string;
  batch: ImportBatch;
  counts: ImportCounts;
}

export interface TantivyCompileSummary {
  indexedDocCount: number;
}

export interface CompileImportSummary {
  providers: ProviderCompileSummary[];
  importedAny: boolean;
  tantivy: TantivyCompileSummary | null;
  tantivyError: string | null;
  fts5Error: string | null;
}

export interface ParquetCompileSummary {
  outDir: string;
  manifestPath: string;
  tableCount: number;
  files: Record<string, string>;
  counts: Record<string, number>;
}

export const COMPILE_PROVIDERS: CompileProviderConfig[] = [
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

export function getCompileProvider(source: SourceTool): CompileProviderConfig {
  const provider = COMPILE_PROVIDERS.find((p) => p.name === source);
  if (!provider) {
    throw new Error(`unknown compile source: ${source}`);
  }
  return provider;
}

export function resolveCompilePath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export async function runCompileImports(options: {
  bundle: Bundle;
  providers: CompileProviderConfig[];
  sessionsPath?: string;
  logger?: CompileLogger;
  onProviderComplete?: (summary: ProviderCompileSummary) => void;
  onTantivyComplete?: (summary: TantivyCompileSummary) => void;
}): Promise<CompileImportSummary> {
  const { bundle, providers, logger } = options;
  let importedAny = false;
  const summaries: ProviderCompileSummary[] = [];
  let tantivy: TantivyCompileSummary | null = null;
  let tantivyError: string | null = null;
  let fts5Error: string | null = null;

  try {
    logger?.info('disabling FTS5 triggers for bulk rebuild');
    disableFts5Triggers(bundle);

    for (const provider of providers) {
      const sourcePath = resolveCompilePath(options.sessionsPath ?? provider.defaultSessionsPath());
      const providerLogger = logger?.child({
        source_tool: provider.name,
        source_path: sourcePath,
      });
      providerLogger?.info('starting compile');
      const r = await provider.compile(bundle, sourcePath, { logger: providerLogger });
      importedAny ||= r.counts.source_files_imported > 0;
      providerLogger?.info(
        {
          batch_id: r.batch.batch_id,
          counts: r.counts,
        },
        'compile finished',
      );

      const summary = {
        source: provider.name,
        sourcePath,
        batchId: r.batch.batch_id,
        batch: r.batch,
        counts: r.counts,
      };
      summaries.push(summary);
      options.onProviderComplete?.(summary);
    }

    if (importedAny) {
      logger?.info({ changed: importedAny }, 'marking indexes');
      markIndexesAfterImport(bundle, { changed: true });

      try {
        logger?.info('rebuilding fts5 index');
        rebuildFts5Index(bundle);
      } catch (error) {
        fts5Error = getErrorMessage(error);
        logger?.error({ err: error }, 'fts5 rebuild failed; SQLite data is intact');
      }

      try {
        logger?.info('rebuilding tantivy index');
        const status = await rebuildTantivyIndex(bundle);
        tantivy = { indexedDocCount: status.indexed_doc_count };
        options.onTantivyComplete?.(tantivy);
      } catch (error) {
        tantivyError = getErrorMessage(error);
        logger?.error({ err: error }, 'tantivy rebuild failed; SQLite data is intact');
      }
    }
  } finally {
    enableFts5Triggers(bundle);
  }

  return {
    providers: summaries,
    importedAny,
    tantivy,
    tantivyError,
    fts5Error,
  };
}

export async function exportCompileParquet(options: {
  storePath: string;
  logger?: CompileLogger;
}): Promise<ParquetCompileSummary> {
  const storePath = resolveCompilePath(options.storePath);
  options.logger?.info({ store_path: storePath }, 'exporting parquet');
  const result = await exportBundleParquet({ bundlePath: storePath });
  return {
    outDir: result.outDir,
    manifestPath: result.manifestPath,
    tableCount: Object.keys(result.files).length,
    files: result.files,
    counts: result.counts,
  };
}
