// Loose TypeScript shapes for the Codex JSONL envelope. We don't validate
// strictly — files in the wild contain legacy records, half-deprecated
// shapes, and forward-compatible additions. The importer treats unknown
// shapes as raw_records with parser_status='partial' instead of failing.

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

export interface CodexContentItem {
  type?: string
  text?: string
  // image variants etc.
}

export type CodexLegacyMessage = {
  role?: string
  content?: unknown
  timestamp?: string
}
