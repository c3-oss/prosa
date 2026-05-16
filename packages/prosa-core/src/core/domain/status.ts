import type { SourceTool, ToolCallStatus } from './types.js'

const CANONICAL_TOOL_CALL_STATUSES = new Set<string>(['started', 'success', 'error', 'cancelled', 'unknown'])

/**
 * Canonical session lifecycle vocabulary used across importers. Sources spell
 * these out in many ways (`stop`, `tool_calls`, `failure`, `cancel`); the
 * normalizer collapses them so the projection stays consistent.
 */
export function normalizeSessionStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const normalized = status.trim().toLowerCase()
  if (normalized === 'stop' || normalized === 'completed' || normalized === 'success') return 'completed'
  if (normalized === 'tool_calls') return 'completed'
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error'
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'cancel') return 'cancelled'
  return 'unknown'
}

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
