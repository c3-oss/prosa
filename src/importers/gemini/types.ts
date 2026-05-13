// Loose TypeScript shapes for Gemini CLI's chats/session-*.json files.

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

export interface GeminiContentItem {
  type?: string
  text?: string
}

export interface GeminiThought {
  subject?: string
  description?: string
  timestamp?: string
}

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

export interface GeminiResultDisplay {
  filePath?: string
  fileName?: string
  fileDiff?: string
  diffStat?: unknown
  isNewFile?: boolean
  originalContent?: string
  newContent?: string
}
