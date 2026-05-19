// Cursor session-store discovery (v2).
//
// Cursor writes one SQLite database per (workspace, agent) at
// `<root>/<workspace>/<agent>/store.db`. The minimal v2 importer
// preserves the database as opaque bytes (one source_file + one
// raw_record + one session per db) so a future iteration can add
// per-row decoding without invalidating earlier sealed bundles.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface CursorStoreHint {
  filePath: string
  workspaceId: string
  agentId: string
}

export async function* discoverCursorStores(root: string): AsyncGenerator<CursorStoreHint, void, void> {
  const workspaces = await readdirSafe(root)
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsPath = join(root, ws.name)
    const agents = await readdirSafe(wsPath)
    for (const ag of agents) {
      if (!ag.isDirectory()) continue
      const agentDir = join(wsPath, ag.name)
      const entries = await readdirSafe(agentDir)
      if (!entries.some((e) => e.isFile() && e.name === 'store.db')) continue
      yield {
        filePath: join(agentDir, 'store.db'),
        workspaceId: ws.name,
        agentId: ag.name,
      }
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
