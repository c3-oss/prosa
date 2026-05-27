// Hermes session discovery (v2) — minimal slice.
//
// Hermes stores sessions under `~/.hermes/sessions/`:
//   - `*.jsonl` — per-session transcript logs (one record per line)
//   - `session_*.json` — per-session JSON snapshot files
//   - `sessions.json` — index file (skipped in the minimal slice)
//   - `../state.db` — global SQLite state (skipped in the minimal slice)
//
// The minimal v2 importer emits one Provider entry per JSONL or JSON
// file. Cross-file merging (sqlite_plus_jsonl) is deferred.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type HermesFileKind = 'session_jsonl' | 'session_json'

export interface HermesFileHint {
  filePath: string
  kind: HermesFileKind
}

export async function* discoverHermesFiles(root: string): AsyncGenerator<HermesFileHint, void, void> {
  const entries = await readdirSafe(root)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue
    if (entry.name === 'sessions.json') continue
    if (entry.name.endsWith('.jsonl')) {
      yield { filePath: join(root, entry.name), kind: 'session_jsonl' }
      continue
    }
    if (entry.name.startsWith('session_') && entry.name.endsWith('.json')) {
      yield { filePath: join(root, entry.name), kind: 'session_json' }
    }
  }
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
