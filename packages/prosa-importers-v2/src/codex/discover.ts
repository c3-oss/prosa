// Codex session-file discovery (v2).
//
// Codex writes one rollout per session into
// `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. The
// v2 importer follows the same convention as v1: anything ending in
// `.jsonl` under `root` counts. The hash of the file's bytes (computed
// at `cheapIdentify` time) drives the `source_file_id` derivation.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function* discoverCodexSessionFiles(root: string): AsyncGenerator<string, void, void> {
  yield* walk(root)
}

async function* walk(dir: string): AsyncGenerator<string, void, void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full
    }
  }
}
