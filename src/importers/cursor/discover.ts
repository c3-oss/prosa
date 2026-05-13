import { readdir } from 'node:fs/promises'
import path from 'node:path'

export interface CursorStoreDb {
  filePath: string
  workspaceId: string
  agentId: string
}

/**
 * Walk `<root>` (typically `~/.cursor/chats`) and yield every `store.db`
 * SQLite file together with the workspace/agent ids derived from the path.
 * Layout: `<root>/<workspace>/<agent>/store.db`.
 */
export async function* discoverCursorStores(root: string): AsyncGenerator<CursorStoreDb, void, void> {
  const workspaces = await readdirSafe(root)
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsPath = path.join(root, ws.name)
    const agents = await readdirSafe(wsPath)
    for (const ag of agents) {
      if (!ag.isDirectory()) continue
      const dbPath = path.join(wsPath, ag.name, 'store.db')
      const dbEntries = await readdirSafe(path.join(wsPath, ag.name))
      const hasStoreDb = dbEntries.some((e) => e.isFile() && e.name === 'store.db')
      if (!hasStoreDb) continue
      yield {
        filePath: dbPath,
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
