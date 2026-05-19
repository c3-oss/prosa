// Gemini CLI session-file discovery (v2).
//
// Gemini writes per-session JSON snapshots into
// `<root>/<projectDir>/chats/session-*.json`. The optional
// `<root>/<projectDir>/.project_root` companion file resolves to the
// project's filesystem path. `bin/` and `logs.json` are skipped.

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface GeminiChatHint {
  filePath: string
  projectDir: string
  projectRoot: string | null
}

export async function* discoverGeminiChats(root: string): AsyncGenerator<GeminiChatHint, void, void> {
  const entries = await readdirSafe(root)
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name === 'bin') continue
    const projectRoot = await readProjectRoot(join(root, entry.name))
    const chatsDir = join(root, entry.name, 'chats')
    const chats = await readdirSafe(chatsDir)
    for (const c of chats.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!c.isFile()) continue
      if (!c.name.startsWith('session-') || !c.name.endsWith('.json')) continue
      yield { filePath: join(chatsDir, c.name), projectDir: entry.name, projectRoot }
    }
  }
}

async function readProjectRoot(dir: string): Promise<string | null> {
  try {
    const text = await readFile(join(dir, '.project_root'), 'utf8')
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
