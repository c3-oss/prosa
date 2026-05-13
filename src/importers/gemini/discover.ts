import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

export interface GeminiChatFile {
  filePath: string
  /** Either a 64-hex hash or a project slug. */
  projectDir: string
  /** Resolved from `.project_root` if it exists in the project dir. */
  projectRoot: string | null
}

/**
 * Walk `<root>` (typically `~/.gemini/tmp`) and yield every
 * `chats/session-*.json` file together with the resolved `.project_root`.
 * Ignores `logs.json` and the `bin/` directory.
 */
export async function* discoverGeminiChats(root: string): AsyncGenerator<GeminiChatFile, void, void> {
  const entries = await readdirSafe(root)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'bin') continue
    const projectRoot = await readProjectRoot(path.join(root, entry.name))
    const chatsDir = path.join(root, entry.name, 'chats')
    const chatEntries = await readdirSafe(chatsDir)
    for (const c of chatEntries) {
      if (!c.isFile()) continue
      if (!c.name.startsWith('session-') || !c.name.endsWith('.json')) continue
      yield {
        filePath: path.join(chatsDir, c.name),
        projectDir: entry.name,
        projectRoot,
      }
    }
  }
}

async function readProjectRoot(dir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(dir, '.project_root'), 'utf8')
    return text.replace(/\n+$/, '').trim() || null
  } catch {
    return null
  }
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
