import os from 'node:os'
import path from 'node:path'
import type { Bundle } from '../core/bundle.js'
import type { SourceTool } from '../core/domain/types.js'
import { getErrorMessage } from '../core/errors.js'
import type { ImportBatch, ImportCounts } from '../core/ingest/batch.js'
import { compileClaude } from '../importers/claude/index.js'
import { compileCodex } from '../importers/codex/index.js'
import type { CompileLogger, CompileOptions } from '../importers/compile-options.js'
import { compileCursor } from '../importers/cursor/index.js'
import { compileGemini } from '../importers/gemini/index.js'
import { compileHermes } from '../importers/hermes/index.js'
import { exportBundleParquet } from './export/parquet.js'
import {
  disableFts5Triggers,
  enableFts5Triggers,
  markIndexesAfterImport,
  rebuildFts5Index,
  rebuildTantivyIndex,
} from './indexing.js'

/** Importer result shape normalized for compile orchestration. */
export interface CompileResult {
  /** Import batch created by the provider. */
  batch: ImportBatch
  /** Final provider import counts. */
  counts: ImportCounts
}

/** Configures one source-tool importer for the compile service. */
export interface CompileProviderConfig {
  /** Source tool handled by this provider. */
  name: SourceTool
  /** Human-readable provider description. */
  description: string
  /** Help text describing the expected root path. */
  pathHelp: string
  /** Default native history location for this provider. */
  defaultSessionsPath: () => string
  /** Provider compile implementation. */
  compile: (bundle: Bundle, root: string, options?: CompileOptions) => Promise<CompileResult>
}

/** Per-provider summary emitted after an importer finishes. */
export interface ProviderCompileSummary {
  /** Source tool that completed. */
  source: SourceTool
  /** Resolved source path compiled by the provider. */
  sourcePath: string
  /** Batch identifier for this provider run. */
  batchId: string
  /** Import batch metadata. */
  batch: ImportBatch
  /** Final import counts. */
  counts: ImportCounts
}

/** Summary emitted after a Tantivy rebuild completes during compile. */
export interface TantivyCompileSummary {
  /** Documents present in the rebuilt Tantivy index. */
  indexedDocCount: number
}

/** Aggregate result for a compile import run across one or more providers. */
export interface CompileImportSummary {
  /** Per-provider summaries in execution order. */
  providers: ProviderCompileSummary[]
  /** True when at least one source file was imported. */
  importedAny: boolean
  /** Tantivy rebuild summary, if it completed. */
  tantivy: TantivyCompileSummary | null
  /** Tantivy rebuild error message, if rebuild failed but compile continued. */
  tantivyError: string | null
  /** FTS5 rebuild error message, if rebuild failed but compile continued. */
  fts5Error: string | null
}

/** Summary returned after compile-triggered Parquet export. */
export interface ParquetCompileSummary {
  /** Directory containing generated Parquet files. */
  outDir: string
  /** Path to the generated export manifest. */
  manifestPath: string
  /** Number of exported canonical tables. */
  tableCount: number
  /** Absolute output file path by table. */
  files: Record<string, string>
  /** Row count by table. */
  counts: Record<string, number>
}

/** Options for running compile imports across configured providers. */
export interface CompileImportOptions {
  /** Open bundle to import into. */
  bundle: Bundle
  /** Providers to run in order. */
  providers: CompileProviderConfig[]
  /** Optional override for every provider's default source path. */
  sessionsPath?: string
  /**
   * Force a full rebuild of derived indexes after import. Tantivy is the
   * only sidecar with an incremental path today, so this currently flips
   * Tantivy to a from-scratch rebuild; FTS5 and Parquet are always
   * full-rewrite. Surfaced by `prosa compile … --overwrite`.
   */
  overwrite?: boolean
  /** Optional structured logger. */
  logger?: CompileLogger
  /** Callback invoked after each provider completes. */
  onProviderComplete?: (summary: ProviderCompileSummary) => void
  /** Callback invoked after Tantivy rebuild completes. */
  onTantivyComplete?: (summary: TantivyCompileSummary) => void
}

/** Options for compile's Parquet export step. */
export interface ExportCompileParquetOptions {
  /** Bundle root whose canonical tables should be exported. */
  storePath: string
  /** Optional structured logger. */
  logger?: CompileLogger
}

/** Built-in compile providers and their default history locations. */
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
  {
    name: 'hermes',
    description: 'Import Hermes session histories into the bundle.',
    pathHelp: 'root of Hermes sessions',
    defaultSessionsPath: () => path.join(os.homedir(), '.hermes', 'sessions'),
    compile: compileHermes,
  },
]

/** Resolves a compile provider by source tool, throwing for unsupported names. */
export function getCompileProvider(source: SourceTool): CompileProviderConfig {
  const provider = COMPILE_PROVIDERS.find((p) => p.name === source)
  if (!provider) {
    throw new Error(`unknown compile source: ${source}`)
  }
  return provider
}

/** Expands shell-style home paths and resolves compile paths to absolutes. */
export function resolveCompilePath(p: string, basePath = process.env.INIT_CWD ?? process.cwd()): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (path.isAbsolute(p)) return path.resolve(p)
  return path.resolve(basePath, p)
}

/** Runs provider imports and refreshes derived search indexes when data changed. */
export async function runCompileImports(options: CompileImportOptions): Promise<CompileImportSummary> {
  const { bundle, providers, logger } = options
  const overwrite = options.overwrite === true
  let importedAny = false
  const summaries: ProviderCompileSummary[] = []
  let tantivy: TantivyCompileSummary | null = null
  let tantivyError: string | null = null
  let fts5Error: string | null = null

  try {
    // Sweep any unfinished import_batches left behind by a previous crash so
    // they don't keep tripping `prosa doctor` after every successful compile.
    // SQLite is single-writer; if we're here, no other process owns those rows.
    const sweep = bundle.db
      .prepare(
        `UPDATE import_batches SET status = 'failed', finished_at = datetime('now')
         WHERE finished_at IS NULL`,
      )
      .run()
    if (sweep.changes > 0) {
      logger?.warn({ batches_reaped: sweep.changes }, 'reaped unfinished import_batches from a prior crash')
    }

    logger?.info('disabling FTS5 triggers for bulk rebuild')
    disableFts5Triggers(bundle)

    for (const provider of providers) {
      const sourcePath = resolveCompilePath(options.sessionsPath ?? provider.defaultSessionsPath())
      const providerLogger = logger?.child({
        source_tool: provider.name,
        source_path: sourcePath,
      })
      providerLogger?.info('starting compile')
      const r = await provider.compile(bundle, sourcePath, { logger: providerLogger })
      importedAny ||= r.counts.source_files_imported > 0
      providerLogger?.info(
        {
          batch_id: r.batch.batch_id,
          counts: r.counts,
        },
        'compile finished',
      )

      const summary = {
        source: provider.name,
        sourcePath,
        batchId: r.batch.batch_id,
        batch: r.batch,
        counts: r.counts,
      }
      summaries.push(summary)
      options.onProviderComplete?.(summary)
    }

    const shouldRebuildIndexes = importedAny || overwrite
    if (shouldRebuildIndexes) {
      logger?.info(
        { changed: importedAny, overwrite },
        importedAny ? 'marking indexes' : 'overwrite forces rebuild despite no new imports',
      )
      markIndexesAfterImport(bundle, { changed: true })

      try {
        logger?.info('rebuilding fts5 index')
        rebuildFts5Index(bundle)
      } catch (error) {
        fts5Error = getErrorMessage(error)
        logger?.error({ err: error }, 'fts5 rebuild failed; SQLite data is intact')
      }

      try {
        logger?.info({ overwrite }, 'rebuilding tantivy index')
        const status = await rebuildTantivyIndex(bundle, { overwrite })
        tantivy = { indexedDocCount: status.indexed_doc_count }
        options.onTantivyComplete?.(tantivy)
      } catch (error) {
        tantivyError = getErrorMessage(error)
        logger?.error({ err: error }, 'tantivy rebuild failed; SQLite data is intact')
      }
    }
  } finally {
    enableFts5Triggers(bundle)
  }

  return {
    providers: summaries,
    importedAny,
    tantivy,
    tantivyError,
    fts5Error,
  }
}

/** Exports the compiled bundle to Parquet using compile command path semantics. */
export async function exportCompileParquet(options: ExportCompileParquetOptions): Promise<ParquetCompileSummary> {
  const storePath = resolveCompilePath(options.storePath)
  options.logger?.info({ store_path: storePath }, 'exporting parquet')
  const result = await exportBundleParquet({ bundlePath: storePath })
  return {
    outDir: result.outDir,
    manifestPath: result.manifestPath,
    tableCount: Object.keys(result.files).length,
    files: result.files,
    counts: result.counts,
  }
}
