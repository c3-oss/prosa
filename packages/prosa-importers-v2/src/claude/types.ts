// Loose Claude Code JSONL envelope shape. The native records carry both
// session-meta-style fields at the top of the file and per-line content
// blocks; this importer treats the first line as the de-facto session
// header.

export interface ClaudeRecord {
  type?: string
  uuid?: string
  parentUuid?: string | null
  sessionId?: string
  isSidechain?: boolean
  agentId?: string
  agentName?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  version?: string
  userType?: string
  message?: ClaudeMessage
}

export interface ClaudeMessage {
  id?: string
  role?: string
  model?: string
  content?: unknown
  type?: string
  stop_reason?: string
  usage?: Record<string, unknown>
}
