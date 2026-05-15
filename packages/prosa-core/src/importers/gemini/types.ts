/**
 * Recovered Gemini CLI `chats/session-*.json` shape. This is a loose importer
 * input for observed snapshots, not a validator for the native format.
 */
export interface GeminiSessionFile {
  sessionId?: string
  projectHash?: string
  startTime?: string
  lastUpdated?: string
  kind?: string
  summary?: string
  messages?: GeminiMessage[]
}

/** Loose Gemini message snapshot entry recovered from a session file. */
export interface GeminiMessage {
  type?: string // 'user' | 'gemini' | 'info' | 'error'
  id?: string
  timestamp?: string
  content?: string | GeminiContentItem[]
  displayContent?: string
  model?: string
  thoughts?: GeminiThought[]
  tokens?: {
    input?: number
    output?: number
    thoughts?: number
    tool?: number
    cached?: number
    total?: number
  }
  toolCalls?: GeminiToolCall[]
}

/** Loose Gemini content item from message content arrays. */
export interface GeminiContentItem {
  type?: string
  text?: string
}

/** Recovered Gemini thought entry, indexed as hidden reasoning rather than default text. */
export interface GeminiThought {
  subject?: string
  description?: string
  timestamp?: string
}

/** Loose Gemini tool-call entry, including result display metadata when present. */
export interface GeminiToolCall {
  id?: string
  name?: string
  description?: string
  args?: Record<string, unknown>
  status?: string
  timestamp?: string
  result?: GeminiToolResult[]
  resultDisplay?: string | GeminiResultDisplay
  renderOutputAsMarkdown?: boolean
}

/** Recovered Gemini tool result entry, usually text or a function response wrapper. */
export interface GeminiToolResult {
  functionResponse?: {
    id?: string
    name?: string
    response?: {
      output?: unknown
      error?: unknown
    }
  }
  text?: string
}

/** Recovered Gemini result display metadata used to preserve file diffs as artifacts. */
export interface GeminiResultDisplay {
  filePath?: string
  fileName?: string
  fileDiff?: string
  diffStat?: unknown
  isNewFile?: boolean
  originalContent?: string
  newContent?: string
}
