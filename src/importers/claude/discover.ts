import { readdir } from 'node:fs/promises'
import path from 'node:path'

export interface ClaudeFile {
  /** Absolute path to a JSONL session file. */
  filePath: string
  /** Project slug (the dashed directory name under projects/). */
  projectSlug: string
  /** Whether the file is a subagent rollout under `<session>/subagents/`. */
  isSubagent: boolean
  /**
   * For main files: the session-id derived from the filename.
   * For subagent files: the session-id from the parent directory; the subagent
   * has the same `sessionId` field internally but a distinct `agentId`.
   */
  parentSessionId: string | null
  /** For subagent files only: agent id parsed from `agent-<id>.jsonl`. */
  agentId: string | null
  /** Path to the companion `.meta.json`, if any (subagents only). */
  metaPath: string | null
}

/**
 * Walk `<root>` (typically `~/.claude/projects`) and yield every JSONL file
 * under it, classified as main session or subagent. We deliberately ignore
 * `sessions-index.json` (per the recovery report it's incomplete) and skip
 * `tool-results/` and `memory/` for the MVP.
 */
export async function* discoverClaudeFiles(root: string): AsyncGenerator<ClaudeFile, void, void> {
  const projectDirs = await readdirSafe(root)
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    const projectRoot = path.join(root, project.name)
    yield* walkProject(projectRoot, project.name)
  }
}

async function* walkProject(projectRoot: string, projectSlug: string): AsyncGenerator<ClaudeFile, void, void> {
  const entries = await readdirSafe(projectRoot)
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield {
        filePath: path.join(projectRoot, entry.name),
        projectSlug,
        isSubagent: false,
        parentSessionId: null,
        agentId: null,
        metaPath: null,
      }
      continue
    }
    if (entry.isDirectory()) {
      // Could be a session-id dir with subagents/ inside; or memory/; or other.
      const subagentsDir = path.join(projectRoot, entry.name, 'subagents')
      const subagentEntries = await readdirSafe(subagentsDir)
      for (const sub of subagentEntries) {
        if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue
        if (!sub.name.startsWith('agent-')) continue
        const agentId = sub.name.slice('agent-'.length, -'.jsonl'.length)
        const metaCandidate = path.join(subagentsDir, `agent-${agentId}.meta.json`)
        const metaExists = subagentEntries.some((e) => e.isFile() && e.name === `agent-${agentId}.meta.json`)
        yield {
          filePath: path.join(subagentsDir, sub.name),
          projectSlug,
          isSubagent: true,
          parentSessionId: entry.name,
          agentId,
          metaPath: metaExists ? metaCandidate : null,
        }
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
