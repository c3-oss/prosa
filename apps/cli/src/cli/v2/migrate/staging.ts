// Lane 9 — migration staging tree.
//
// Provider discovery in v2 walks a real filesystem tree, so the
// cleanest way to feed v1 raw bytes back through `runCompileImports`
// is to stage them in a per-provider directory mimicking the
// provider's discovery convention. Each provider's `discover` ignores
// files that don't match its naming pattern, so the staging layout
// preserves the extension/prefix expected by each importer.
//
// The staging tree lives under `<bundle.paths.tmp>/migration-staging/`
// and is implicitly cleaned up alongside the rest of the bundle on
// successful seal + rename (the entire v2 bundle moves to the v1
// path; the staging dir under `tmp/` is dropped on the next writer
// open via `reapStaleTmp`).

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { SourceTool } from '@c3-oss/prosa-types-v2'

export type StagingInput = {
  /** Per-tool staging root, e.g. `<tmp>/migration-staging/codex`. */
  root: string
  tool: SourceTool
  sourceFileId: string
  contentHash: string
  originalPath: string
  fileKind: string
  bytes: Uint8Array
}

/**
 * Write `bytes` to a deterministic staging path for the given
 * provider so its `discover` walks it on the next
 * `runCompileImports`. Returns the absolute path written.
 */
export async function writeBytesToMigrationStaging(input: StagingInput): Promise<string> {
  const target = layoutFor(input)
  await mkdir(dirnameOf(target), { recursive: true })
  await writeFile(target, input.bytes)
  return target
}

function layoutFor(input: StagingInput): string {
  const safeBase = sanitizeFilename(basename(input.originalPath))
  switch (input.tool) {
    case 'codex': {
      // Codex discovery walks `<root>/**/*.jsonl`. Group by content hash
      // prefix to keep the per-directory file count bounded.
      const hashPrefix = input.contentHash.slice(0, 2)
      const fileName = ensureExtension(safeBase, '.jsonl')
      return join(input.root, hashPrefix, fileName)
    }
    case 'claude': {
      // Claude discovery walks `<root>/<project>/...jsonl` (plus
      // optional `<root>/<project>/<sid>/subagents/agent-*.jsonl`).
      // Group every migrated file under a synthetic project so the
      // top-level scan finds them.
      const project = `migration-${input.contentHash.slice(0, 8)}`
      const fileName = ensureExtension(safeBase, '.jsonl')
      return join(input.root, project, fileName)
    }
    case 'cursor': {
      // Cursor discovery requires `<root>/<workspace>/<agent>/store.db`.
      // Each source file must be its own agent dir so discovery sees
      // it as a separate workspace.
      const ws = `ws-migration-${input.contentHash.slice(0, 8)}`
      const agent = `agent-${input.sourceFileId.slice(0, 16)}`
      return join(input.root, ws, agent, 'store.db')
    }
    case 'gemini': {
      // Gemini discovery requires `<root>/<projectDir>/chats/session-*.json`.
      const proj = `proj-migration-${input.contentHash.slice(0, 8)}`
      const fileName = ensureGeminiSessionName(safeBase, input.contentHash)
      return join(input.root, proj, 'chats', fileName)
    }
    case 'hermes': {
      // Hermes discovery accepts top-level `*.jsonl` or
      // `session_*.json`; we keep the original extension where
      // possible and otherwise default to `.jsonl`.
      if (input.fileKind === 'session_json' || safeBase.endsWith('.json')) {
        const fileName = safeBase.startsWith('session_') ? safeBase : `session_${input.contentHash.slice(0, 12)}.json`
        return join(input.root, fileName)
      }
      const fileName = ensureExtension(safeBase, '.jsonl')
      return join(input.root, fileName)
    }
  }
}

function ensureExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`
}

function ensureGeminiSessionName(name: string, contentHash: string): string {
  if (name.startsWith('session-') && name.endsWith('.json')) return name
  return `session-${contentHash.slice(0, 12)}.json`
}

function sanitizeFilename(name: string): string {
  // Restrict to a filesystem-safe subset so a v1 path with shell
  // metacharacters cannot escape the staging root.
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'staged'
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx <= 0 ? p : p.slice(0, idx)
}
