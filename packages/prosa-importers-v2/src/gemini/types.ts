// Loose Gemini CLI `session-*.json` shape (mirrors v1 importer).

export interface GeminiSessionFile {
  sessionId?: string
  projectHash?: string
  startTime?: string
  lastUpdated?: string
  kind?: string
  summary?: string
  messages?: GeminiMessage[]
}

export interface GeminiMessage {
  type?: string
  id?: string
  timestamp?: string
  content?: unknown
  displayContent?: string
  model?: string
  thoughts?: unknown
  tokens?: Record<string, unknown>
  toolCalls?: unknown[]
}
