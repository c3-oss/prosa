// Lane 9 — provider-directory recompile fallback.
//
// Migration normally re-projects from the v1 bundle's preserved raw
// bytes (`raw/sources/<blake3>.zst`). When those bytes are missing or
// corrupted on disk, the per-source-file pipeline records a "gap" and
// the caller can fall back to walking the original provider
// directories (`~/.codex`, `~/.claude`, etc.) for that source tool.
//
// This module is the one-time disaster-recovery surface. It is NOT a
// compat shim — the v2 importer remains the only writer.

import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

import type { Bundle as BundleV2 } from '@c3-oss/prosa-bundle-v2'
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

export type MigrationGap = {
  source_file_id: string
  source_tool: SourceTool
  path: string
  reason: 'raw_bytes_missing' | 'raw_bytes_corrupted' | 'object_missing' | 'decompress_failed'
  detail?: string
}

export type ProviderFallbackOptions = {
  /** Target v2 bundle to write into. */
  bundle: BundleV2
  /** Gaps collected during the raw-bytes pass — drives which provider roots are walked. */
  gaps: readonly MigrationGap[]
  /** Override the discovery root per source tool (defaults to $HOME/...). */
  roots?: Partial<Record<SourceTool, string>>
}

export type ProviderFallbackResult = {
  /** Source tools that had at least one gap and were attempted for re-walk. */
  attempted: SourceTool[]
  /** Tools that successfully sealed a follow-up epoch. */
  succeeded: SourceTool[]
  /** Tools where discovery walking failed (e.g. root missing on disk). */
  skipped: Array<{ tool: SourceTool; reason: string }>
  /** Sealed epoch numbers produced by the follow-up `runCompileImports`. */
  sealedEpochs: number[]
}

/**
 * Walk the provider directories for every source tool that surfaced a
 * gap and run `runCompileImports` against the v2 bundle. Each call
 * seals its own epoch so the bundle's epoch chain advances atomically
 * per tool. Missing roots are reported in `skipped` without aborting
 * the surrounding migration.
 */
export async function recompileFromProviderDirectories(
  options: ProviderFallbackOptions,
): Promise<ProviderFallbackResult> {
  const toolsWithGaps = collectAffectedTools(options.gaps)
  const result: ProviderFallbackResult = {
    attempted: [],
    succeeded: [],
    skipped: [],
    sealedEpochs: [],
  }

  for (const tool of toolsWithGaps) {
    result.attempted.push(tool)
    const root = options.roots?.[tool] ?? defaultProviderRoot(tool)
    try {
      const sealed = await runCompileImports({
        bundle: options.bundle,
        providers: [{ provider: providerFor(tool), root }],
      })
      result.succeeded.push(tool)
      result.sealedEpochs.push(sealed.sealedEpoch)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      result.skipped.push({ tool, reason })
    }
  }

  return result
}

export function collectAffectedTools(gaps: readonly MigrationGap[]): SourceTool[] {
  const set = new Set<SourceTool>()
  for (const gap of gaps) set.add(gap.source_tool)
  return [...set].sort()
}

export function providerFor(tool: SourceTool): Provider {
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

export function defaultProviderRoot(tool: SourceTool): string {
  const home = homedir()
  switch (tool) {
    case 'codex':
      return resolvePath(home, '.codex', 'sessions')
    case 'claude':
      return resolvePath(home, '.claude', 'projects')
    case 'cursor':
      return resolvePath(home, '.cursor', 'chats')
    case 'gemini':
      return resolvePath(home, '.gemini', 'tmp')
    case 'hermes':
      return resolvePath(home, '.hermes', 'sessions')
  }
}
