import { readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Walk a Codex sessions root (default `~/.codex/sessions`) and yield every
 * `rollout-*.jsonl` file. The native layout is `YYYY/MM/DD/rollout-...jsonl`,
 * but we don't depend on that — anything ending in `.jsonl` under `root`
 * counts.
 */
export async function* discoverCodexSessions(root: string): AsyncGenerator<string, void, void> {
  yield* walk(root)
}

/** Recursively traverse a possibly-missing sessions directory without failing discovery. */
async function* walk(dir: string): AsyncGenerator<string, void, void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full
    }
  }
}
