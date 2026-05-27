// Loose Codex JSONL envelope shape (mirrors `prosa-core` v1 importer).

export interface CodexEnvelope {
  type?: string
  timestamp?: string
  payload?: Record<string, unknown>
}

export interface CodexSessionMetaPayload {
  id?: string
  timestamp?: string
  cwd?: string
  cli_version?: string
  originator?: string
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

export interface CodexTurnContextPayload {
  turn_id?: string
  cwd?: string
  model?: string
  effort?: string
  approval_policy?: string
  sandbox_policy?: string | { mode?: string }
  current_date?: string
  timezone?: string
}

/** Loose `response_item` payload — assistant/user messages, tool calls, etc. */
export interface CodexResponseItemPayload {
  id?: string
  type?: string
  role?: string
  model?: string
  turn_id?: string
  parent_message_id?: string
  content?: CodexContentItem[] | string
  call_id?: string
  name?: string
  arguments?: string | Record<string, unknown>
  output?: unknown
  status?: string
  is_error?: boolean
}

/** Loose content item inside `response_item.content`. */
export interface CodexContentItem {
  type?: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  is_error?: boolean
}

/** Loose `event_msg` payload — operational session events. */
export interface CodexEventMsgPayload {
  id?: string
  turn_id?: string
  subtype?: string
  actor?: string
  message?: string
  level?: string
}
