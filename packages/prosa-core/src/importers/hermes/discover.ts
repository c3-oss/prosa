import { access, readdir } from 'node:fs/promises'
import path from 'node:path'

/** Hermes source files discovered from a sessions directory. */
export interface HermesSources {
  /** Root sessions directory passed to the importer. */
  sessionsDir: string
  /** Sibling `state.db`, when present. */
  stateDbPath: string | null
  /** Top-level `sessions.json` index, when present. */
  indexPath: string | null
  /** Top-level legacy transcript JSONL files. */
  jsonlFiles: string[]
  /** Top-level CLI JSON session snapshots. */
  jsonFiles: string[]
}

/** Discover Hermes session storage under `root`, normally `~/.hermes/sessions`. */
export async function discoverHermesSources(root: string): Promise<HermesSources> {
  const sessionsDir = path.resolve(root)
  const stateDbCandidate = path.join(path.dirname(sessionsDir), 'state.db')
  const indexCandidate = path.join(sessionsDir, 'sessions.json')
  const entries = await readdirSafe(sessionsDir)

  const jsonlFiles: string[] = []
  const jsonFiles: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const full = path.join(sessionsDir, entry.name)
    if (entry.name === 'sessions.json') continue
    if (entry.name.endsWith('.jsonl')) {
      jsonlFiles.push(full)
      continue
    }
    if (entry.name.startsWith('session_') && entry.name.endsWith('.json')) {
      jsonFiles.push(full)
    }
  }

  return {
    sessionsDir,
    stateDbPath: (await exists(stateDbCandidate)) ? stateDbCandidate : null,
    indexPath: (await exists(indexCandidate)) ? indexCandidate : null,
    jsonlFiles: jsonlFiles.sort(),
    jsonFiles: jsonFiles.sort(),
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
