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
  entrypoint?: string
  promptId?: string
  message?: ClaudeMessage
  data?: Record<string, unknown>
  subtype?: string
  toolUseResult?: unknown
  toolUseID?: string
  parentToolUseID?: string
  sourceToolAssistantUUID?: string
  permissionMode?: string
  level?: string
  isSnapshotUpdate?: boolean
}

export interface ClaudeMessage {
  id?: string
  role?: string
  model?: string
  content?: ClaudeContentBlock[] | string
  type?: string
  stop_reason?: string
  usage?: Record<string, unknown>
}

/** Recovered Claude content block union — final branch keeps unknown
 *  kinds available for raw preservation. */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content?: unknown
      is_error?: boolean
    }
  | { type: 'image'; source: unknown }
  | { type: string; [k: string]: unknown }
