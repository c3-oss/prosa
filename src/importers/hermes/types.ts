/** Loose Hermes SQLite session row. */
export interface HermesSessionRow {
  id: string
  source: string
  user_id: string | null
  model: string | null
  model_config: string | null
  system_prompt: string | null
  parent_session_id: string | null
  started_at: number
  ended_at: number | null
  end_reason: string | null
  message_count: number | null
  tool_call_count: number | null
  title: string | null
}

/** Loose Hermes SQLite message row. */
export interface HermesMessageRow {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: string | null
  tool_name: string | null
  timestamp: number
  token_count: number | null
  finish_reason: string | null
  reasoning: string | null
  reasoning_content: string | null
  reasoning_details: string | null
  codex_reasoning_items: string | null
  codex_message_items: string | null
}

/** Hermes CLI JSON session snapshot. */
export interface HermesSessionJson {
  session_id?: string
  session_start?: string | number
  last_updated?: string | number
  platform?: string
  model?: string
  base_url?: string
  system_prompt?: string
  message_count?: number
  tools?: unknown[]
  messages?: HermesTranscriptMessage[]
}

/** Hermes JSONL transcript message. */
export interface HermesTranscriptMessage {
  role?: string
  content?: unknown
  timestamp?: string | number
  tool_call_id?: string
  tool_calls?: unknown
  tool_name?: string
  token_count?: number
  finish_reason?: string
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: unknown
  codex_reasoning_items?: unknown
  codex_message_items?: unknown
  model?: string
}
