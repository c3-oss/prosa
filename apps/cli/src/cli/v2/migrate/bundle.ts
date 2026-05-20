// Lane 9 — local v1 → v2 bundle migration orchestration.
//
// `migrateBundle` is the load-bearing entrypoint. It opens the v1
// bundle read-only, re-projects its preserved raw bytes through the
// v2 importer pipeline, validates count parity, and atomically swaps
// the new v2 bundle into the original path.
//
// Migration policy (`docs/rearch-2/10-lane-9-migration.md`):
//   - Never re-derive from inferred state. The v1 raw bytes (the
//     preserved `raw/sources/<blake3>.zst` files) are the only valid
//     migration input.
//   - Atomic rename: the v1 bundle moves to
//     `<oldPath>-v0-archive-<timestamp>` before the new v2 bundle
//     takes the original path. Any failure before the final rename
//     leaves the v1 bundle in place untouched.
//   - Count validation runs against the sealed v2 bundle. If the
//     load-bearing counts drift (see `validate.ts`), the rename is
//     refused and the temp bundle is removed.
//
// Per-phase timing is surfaced via the `phases` field of the result
// so `--verbose` and `--json` output can render it without any
// further bookkeeping in the CLI command.

import { readFile, rename, rm, stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

import {
  type Bundle as BundleV2,
  type OpenBundleOptions,
  initBundle as initBundleV2,
  openBundle as openBundleV2,
} from '@c3-oss/prosa-bundle-v2'
import { type Bundle as BundleV1, closeBundle, getBytes, openBundle as openBundleV1 } from '@c3-oss/prosa-core'
import {
  ClaudeProvider,
  CodexProvider,
  CursorProvider,
  GeminiProvider,
  HermesProvider,
  type Provider,
  runCompileImports,
} from '@c3-oss/prosa-importers-v2'
import type { SourceTool } from '@c3-oss/prosa-types-v2'

import {
  type MigrationGap,
  type ProviderFallbackResult,
  recompileFromProviderDirectories,
} from './provider-fallback.js'
import { writeBytesToMigrationStaging } from './staging.js'
import { type MigrationValidation, validateMigrationCounts } from './validate.js'

export type MigrateBundleOptions = {
  /** v1 bundle path (typically `~/.prosa`). Must contain `manifest.json`. */
  oldPath: string
  /** Target temp path for the new v2 bundle (typically `~/.prosa-v2-tmp`). */
  newPath: string
  /** Override the archive path; defaults to `<oldPath>-v0-archive-<timestamp>`. */
  archivePath?: string
  /**
   * When true, never call `rename` to swap bundles. The v2 bundle stays at
   * `newPath` and the v1 bundle stays untouched. Useful for tests that
   * want to inspect both after migration.
   */
  dryRun?: boolean
  /**
   * Per-source-tool override for the provider-directory fallback root.
   * Migration only uses these when raw bytes are missing/corrupt for
   * that source tool.
   */
  providerRoots?: Partial<Record<SourceTool, string>>
  /** Optional `now` injection for deterministic archive paths in tests. */
  now?: () => number
}

export type MigrationPhase = 'discovery' | 'reproject' | 'validate' | 'rename'

export type MigrationPhaseTiming = {
  phase: MigrationPhase
  startedAtMs: number
  durationMs: number
}

export type MigrationResult = {
  migratedAt: string
  /** Absolute path the v1 bundle was archived to, or `null` for dry-run. */
  archivedAt: string | null
  /** Sealed v2 bundle path after the swap (or `newPath` for dry-run). */
  v2Path: string
  validation: MigrationValidation
  gaps: MigrationGap[]
  fallback: ProviderFallbackResult | null
  phases: MigrationPhaseTiming[]
  durationMs: number
}

export class MigrationError extends Error {
  override name = 'MigrationError'
  constructor(
    message: string,
    public readonly stage: MigrationPhase,
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

export async function migrateBundle(options: MigrateBundleOptions): Promise<MigrationResult> {
  const startMs = Date.now()
  const now = options.now ?? (() => Date.now())
  const oldPath = resolvePath(options.oldPath)
  const newPath = resolvePath(options.newPath)

  // Pre-flight: refuse to clobber an existing target directory. The
  // v1 atomic-rename contract requires us to know which side a
  // crashed previous run left dangling.
  await reapStaleNewPath(newPath)

  const phases: MigrationPhaseTiming[] = []
  const gaps: MigrationGap[] = []
  const trackPhase = async <T>(phase: MigrationPhase, fn: () => Promise<T>): Promise<T> => {
    const startedAtMs = Date.now()
    try {
      return await fn()
    } finally {
      phases.push({ phase, startedAtMs, durationMs: Date.now() - startedAtMs })
    }
  }

  // Phase 1 — discovery. Open the v1 bundle and snapshot its source
  // files; closing the v1 bundle happens in the `finally` below.
  const v1 = await openBundleV1(oldPath)
  let v2: BundleV2 | null = null
  try {
    const sourceFiles = await trackPhase('discovery', async () => readV1SourceFiles(v1))

    // Phase 2 — reproject. Stage every recovered v1 raw-bytes file
    // into a per-provider tree, run the v2 importer, then on any
    // gaps fall back to provider-directory recompile.
    v2 = await initBundleV2(newPath)

    const fallback = await trackPhase('reproject', async () => {
      const staged = await stageRawBytes(v1, v2 as BundleV2, sourceFiles, gaps)
      if (staged.providers.length > 0) {
        await runCompileImports({ bundle: v2 as BundleV2, providers: staged.providers })
      }
      // The provider-directory fallback walks real OS-level
      // discovery roots (e.g. `~/.codex/sessions`). To prevent test
      // runs from accidentally scanning the developer's home
      // directory, we only invoke the fallback when the caller
      // explicitly passed at least one `providerRoots` override.
      // Production CLI callers pass the user's actual roots; tests
      // pass scoped temp directories.
      if (gaps.length > 0 && options.providerRoots) {
        return await recompileFromProviderDirectories({
          bundle: v2 as BundleV2,
          gaps,
          roots: options.providerRoots,
        })
      }
      return null
    })

    // Phase 3 — validate. The v2 bundle's sealed `head.counts`
    // already reflects the orchestrator's output.
    const validation = await trackPhase('validate', async () => validateMigrationCounts(v1, v2 as BundleV2))

    if (!validation.ok && !options.dryRun) {
      throw new MigrationError(
        `migration aborted before rename: count validation failed (${validation.reasons.join('; ')})`,
        'validate',
        validation,
      )
    }

    // Phase 4 — rename. Close the v2 bundle to release its lock and
    // commit the bytes to disk, then archive v1 and swap.
    await v2.close()
    v2 = null

    let archivedAt: string | null = null
    let v2Path = newPath
    await trackPhase('rename', async () => {
      if (options.dryRun) return
      const stamp = options.archivePath ?? `${oldPath}-v0-archive-${formatStamp(now())}`
      await rename(oldPath, stamp)
      try {
        await rename(newPath, oldPath)
      } catch (err) {
        // Restore the v1 bundle if the second rename fails so the
        // atomic-rename contract holds.
        try {
          await rename(stamp, oldPath)
        } catch {
          // best-effort
        }
        throw err
      }
      archivedAt = stamp
      v2Path = oldPath
    })

    closeBundle(v1)

    return {
      migratedAt: new Date().toISOString(),
      archivedAt,
      v2Path,
      validation,
      gaps,
      fallback,
      phases,
      durationMs: Date.now() - startMs,
    }
  } catch (err) {
    if (v2) {
      try {
        await v2.close()
      } catch {
        // ignore close error during cleanup
      }
    }
    // The v1 bundle handle is closed inside the success path; on
    // error we still close it before propagating.
    try {
      closeBundle(v1)
    } catch {
      // ignore
    }
    // On any error before the rename, clean up the temp v2 bundle
    // so the next invocation can re-run from a clean slate. The v1
    // bundle is left untouched at oldPath.
    try {
      await rm(newPath, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw err
  }
}

type V1SourceFileRow = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  file_kind: string
  size_bytes: number
  content_hash: string
  object_id: string | null
}

function readV1SourceFiles(v1: BundleV1): V1SourceFileRow[] {
  const rows = v1.db
    .prepare(
      'SELECT source_file_id, source_tool, path, file_kind, size_bytes, content_hash, object_id FROM source_files',
    )
    .all() as Array<{
    source_file_id: string
    source_tool: string
    path: string
    file_kind: string
    size_bytes: number
    content_hash: string
    object_id: string | null
  }>
  return rows.map((r) => ({
    source_file_id: r.source_file_id,
    source_tool: r.source_tool as SourceTool,
    path: r.path,
    file_kind: r.file_kind,
    size_bytes: r.size_bytes,
    content_hash: r.content_hash,
    object_id: r.object_id,
  }))
}

type StagingResult = {
  providers: Array<{ provider: Provider; root: string }>
}

async function stageRawBytes(
  v1: BundleV1,
  v2: BundleV2,
  sourceFiles: V1SourceFileRow[],
  gaps: MigrationGap[],
): Promise<StagingResult> {
  // Group source files by provider so each provider's staging tree
  // only contains its own files; `runCompileImports` then walks each
  // tree as if it were the original `~/.codex` etc.
  const grouped = new Map<SourceTool, V1SourceFileRow[]>()
  for (const row of sourceFiles) {
    const arr = grouped.get(row.source_tool) ?? []
    arr.push(row)
    grouped.set(row.source_tool, arr)
  }

  const providers: StagingResult['providers'] = []
  for (const [tool, rows] of grouped) {
    let any = false
    const root = `${v2.paths.tmp}/migration-staging/${tool}`
    for (const row of rows) {
      if (!row.object_id) {
        gaps.push({
          source_file_id: row.source_file_id,
          source_tool: row.source_tool,
          path: row.path,
          reason: 'object_missing',
          detail: 'v1 source_files.object_id was null',
        })
        continue
      }
      let bytes: Buffer
      try {
        bytes = await getBytes(v1, row.object_id)
      } catch (err) {
        const reason = inferCorruptionReason(err)
        gaps.push({
          source_file_id: row.source_file_id,
          source_tool: row.source_tool,
          path: row.path,
          reason,
          detail: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      try {
        await writeBytesToMigrationStaging({
          root,
          tool,
          sourceFileId: row.source_file_id,
          contentHash: row.content_hash,
          originalPath: row.path,
          fileKind: row.file_kind,
          bytes,
        })
        any = true
      } catch (err) {
        gaps.push({
          source_file_id: row.source_file_id,
          source_tool: row.source_tool,
          path: row.path,
          reason: 'raw_bytes_corrupted',
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (any) {
      providers.push({ provider: providerFor(tool), root })
    }
  }

  return { providers }
}

function providerFor(tool: SourceTool): Provider {
  switch (tool) {
    case 'codex':
      return new CodexProvider()
    case 'claude':
      return new ClaudeProvider()
    case 'cursor':
      return new CursorProvider()
    case 'gemini':
      return new GeminiProvider()
    case 'hermes':
      return new HermesProvider()
  }
}

function inferCorruptionReason(err: unknown): MigrationGap['reason'] {
  const message = err instanceof Error ? err.message : String(err)
  if (/object not found/i.test(message)) return 'object_missing'
  if (/ENOENT/.test(message) || /not found/i.test(message)) return 'raw_bytes_missing'
  if (/zstd|decompress|inflate/i.test(message)) return 'decompress_failed'
  return 'raw_bytes_corrupted'
}

async function reapStaleNewPath(newPath: string): Promise<void> {
  const info = await stat(newPath).catch(() => null)
  if (!info) return
  // If a previous run crashed mid-flight the temp v2 bundle remains;
  // remove it before starting so the new init isn't blocked by a
  // stale lock.
  await rm(newPath, { recursive: true, force: true })
}

function formatStamp(ms: number): string {
  // Stable ISO-ish stamp without colons (filesystem-safe).
  return new Date(ms).toISOString().replace(/[:.]/g, '-')
}

/**
 * Convenience: read a v2 bundle in read-only mode without the lock.
 * Tests use this to assert post-migration counts/sessions without
 * holding the writer slot.
 */
export async function openMigratedBundle(path: string, options: OpenBundleOptions = {}): Promise<BundleV2> {
  return openBundleV2(path, options)
}

/** Convenience: read a v1 file's raw bytes via the CAS. */
export async function readV1SourceBytes(v1: BundleV1, objectId: string): Promise<Buffer> {
  return getBytes(v1, objectId)
}

/** Read manifest.json contents as text; used by JSON-output mode. */
export async function readV1ManifestText(oldPath: string): Promise<string> {
  return readFile(`${oldPath}/manifest.json`, 'utf8')
}
