/**
 * Recovered Codex JSONL envelope shape. This is a loose importer input for
 * known records in the wild, not a validator for the native format.
 */
export interface CodexEnvelope {
  type?: string
  timestamp?: string
  payload?: Record<string, unknown>
}

/**
 * Loose `session_meta` payload recovered from Codex JSONL. Optional fields
 * reflect legacy, current, and forward-compatible records.
 */
export interface CodexSessionMetaPayload {
  id?: string
  timestamp?: string
  cwd?: string
  cli_version?: string
  originator?: string
  source?: unknown
  model_provider?: string
  base_instructions?: string
  agent_role?: string
  agent_nickname?: string
  forked_from_id?: string
  git?: {
    commit_hash?: string
    branch?: string
    repository_url?: string
  }
}

/**
 * Loose `turn_context` payload recovered from Codex JSONL. Values that vary by
 * CLI version stay typed as unknown until normalization needs them.
 */
export interface CodexTurnContextPayload {
  turn_id?: string
  cwd?: string
  model?: string
  effort?: string
  approval_policy?: string
  sandbox_policy?: unknown
  current_date?: string
  timezone?: string
  user_instructions?: string
  summary?: unknown
}

/**
 * Loose `response_item` payload recovered from Codex JSONL. This covers
 * messages, tool calls, tool results, reasoning, and newer opaque item types.
 */
export interface CodexResponseItemPayload {
  type?: string
  role?: string
  content?: unknown
  call_id?: string
  name?: string
  arguments?: unknown
  output?: unknown
  status?: string
  ghost_commit?: unknown
}

/**
 * Loose operational `event_msg` payload recovered from Codex JSONL. The shape
 * is intentionally permissive because event subtypes are not stable.
 */
export interface CodexEventMsgPayload {
  type?: string
  message?: string
  call_id?: string
  command?: unknown
  cwd?: string
  exit_code?: number | null
  stdout?: string
  stderr?: string
  formatted_output?: string
  aggregated_output?: string
  duration?: { secs?: number; nanos?: number }
  status?: string
  changes?: Record<string, unknown>
  invocation?: { server?: string; tool?: string; arguments?: unknown }
  result?: unknown
  reason?: string
  turn_id?: string
}

/** Loose content item recovered from Codex message arrays, including unknown media variants. */
export interface CodexContentItem {
  type?: string
  text?: string
  // image variants etc.
}

/** Legacy top-level message record seen in older Codex exports. */
export type CodexLegacyMessage = {
  role?: string
  content?: unknown
  timestamp?: string
}
