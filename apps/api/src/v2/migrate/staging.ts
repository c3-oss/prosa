// Lane 9 — server-side migration staging.
//
// Mirrors the CLI staging helper (apps/cli/src/cli/v2/migrate/staging.ts)
// but lives inside the API package so the server-side
// `migrateTenant` flow does not depend on the CLI. The layout is
// identical: each provider's tree mimics its discovery convention so
// `runCompileImports` can walk a temp directory as if it were a real
// `~/.codex` / `~/.claude` root.

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { SourceTool } from '@c3-oss/prosa-types-v2'

export type ServerStagingInput = {
  root: string
  tool: SourceTool
  sourceFileId: string
  contentHash: string
  originalPath: string
  fileKind: string
  bytes: Uint8Array
}

export async function writeBytesToServerStaging(input: ServerStagingInput): Promise<string> {
  const target = layoutFor(input)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, input.bytes)
  return target
}

function layoutFor(input: ServerStagingInput): string {
  const safeBase = sanitizeFilename(basename(input.originalPath))
  switch (input.tool) {
    case 'codex': {
      const hashPrefix = input.contentHash.slice(0, 2)
      const fileName = ensureExtension(safeBase, '.jsonl')
      return join(input.root, hashPrefix, fileName)
    }
    case 'claude': {
      const project = `migration-${input.contentHash.slice(0, 8)}`
      const fileName = ensureExtension(safeBase, '.jsonl')
      return join(input.root, project, fileName)
    }
    case 'cursor': {
      const ws = `ws-migration-${input.contentHash.slice(0, 8)}`
      const agent = `agent-${input.sourceFileId.slice(0, 16)}`
      return join(input.root, ws, agent, 'store.db')
    }
    case 'gemini': {
      const proj = `proj-migration-${input.contentHash.slice(0, 8)}`
      const fileName = ensureGeminiSessionName(safeBase, input.contentHash)
      return join(input.root, proj, 'chats', fileName)
    }
    case 'hermes': {
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
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'staged'
}
