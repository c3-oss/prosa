import type { SourceTool, ToolCallStatus } from './types.js'

const CANONICAL_TOOL_CALL_STATUSES = new Set<string>(['started', 'success', 'error', 'cancelled', 'unknown'])

/** Normalize source-specific tool lifecycle values into the canonical vocabulary. */
export function normalizeToolCallStatus(sourceTool: SourceTool, raw: string | null | undefined): ToolCallStatus {
  const status = raw?.trim()
  if (!status) return 'unknown'
  if (CANONICAL_TOOL_CALL_STATUSES.has(status)) return status as ToolCallStatus

  switch (sourceTool) {
    case 'codex':
      if (status === 'completed') return 'success'
      if (status === 'in_progress') return 'started'
      if (status === 'incomplete' || status === 'failed' || status === 'timeout') return 'error'
      if (status === 'canceled') return 'cancelled'
      return 'unknown'
    case 'hermes':
      if (status === 'stop' || status === 'tool_calls') return 'success'
      if (status === 'length' || status === 'content_filter') return 'error'
      return 'unknown'
    case 'gemini':
    case 'claude':
    case 'cursor':
      return 'unknown'
  }
}
