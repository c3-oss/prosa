/**
 * Wire-side transcript types — mirror the `RemoteTranscriptPage` shape
 * returned by `sessions.transcript`. Kept independent of the API client
 * type-export so test fixtures and components can stand alone.
 */

export type TranscriptBlock = {
  blockId: string
  blockType: string
  textInline: string | null
  textObjectId: string | null
  hidden: boolean
  isError: boolean
  mimeType: string | null
}

export type TranscriptToolResult = {
  toolResultId: string
  status: string | null
  isError: boolean
  exitCode: number | null
  durationMs: number | null
  preview: string | null
  stdoutObjectId: string | null
  stderrObjectId: string | null
  outputObjectId: string | null
}

export type TranscriptToolCall = {
  toolCallId: string
  toolName: string
  canonicalToolType: string | null
  argsInline: string | null
  argsObjectId: string | null
  command: string | null
  path: string | null
  status: string | null
  timestampStart: string | null
  result: TranscriptToolResult | null
}

export type TranscriptTurn = {
  messageId: string
  ordinal: number
  role: string
  model: string | null
  timestamp: string | null
  blocks: TranscriptBlock[]
  toolCalls: TranscriptToolCall[]
}
