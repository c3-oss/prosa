// Claude Code session-file discovery (v2).
//
// `~/.claude/projects/<slug>/` contains:
//   - `<sessionId>.jsonl` — main session rollout
//   - `<sessionId>/subagents/agent-<agentId>.jsonl` — subagent rollouts
//   - `<sessionId>/subagents/agent-<agentId>.meta.json` — optional subagent
//     metadata (skipped here; the orchestrator's GraphResolver pairs
//     subagent files with their parents)
//   - other optional dirs (`memory/`, `tool-results/`) — skipped
//
// The v2 discover returns one `DiscoveredSourceFile` per JSONL file plus
// a `metadata.projectSlug` / `metadata.isSubagent` / `metadata.parentSessionId`
// hint encoded in the source_file_id derivation path. The parent-session
// edge is materialised in `parseAndProject`.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface ClaudeFileHint {
  filePath: string
  projectSlug: string
  isSubagent: boolean
  parentSessionId: string | null
  agentId: string | null
}

export async function* discoverClaudeFiles(root: string): AsyncGenerator<ClaudeFileHint, void, void> {
  const projects = await readdirSafe(root)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    yield* walkProject(join(root, project.name), project.name)
  }
}

async function* walkProject(projectRoot: string, projectSlug: string): AsyncGenerator<ClaudeFileHint, void, void> {
  const entries = await readdirSafe(projectRoot)
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield {
        filePath: join(projectRoot, entry.name),
        projectSlug,
        isSubagent: false,
        parentSessionId: null,
        agentId: null,
      }
      continue
    }
    if (entry.isDirectory()) {
      const subagentsDir = join(projectRoot, entry.name, 'subagents')
      const subagents = await readdirSafe(subagentsDir)
      for (const sub of subagents) {
        if (!sub.isFile() || !sub.name.endsWith('.jsonl')) continue
        if (!sub.name.startsWith('agent-')) continue
        const agentId = sub.name.slice('agent-'.length, -'.jsonl'.length)
        yield {
          filePath: join(subagentsDir, sub.name),
          projectSlug,
          isSubagent: true,
          parentSessionId: entry.name,
          agentId,
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
