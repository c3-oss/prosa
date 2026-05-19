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
