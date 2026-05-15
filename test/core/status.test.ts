import { describe, expect, it } from 'vitest'
import { normalizeToolCallStatus } from '../../src/core/domain/status.js'

describe('normalizeToolCallStatus', () => {
  it('keeps canonical statuses unchanged', () => {
    expect(normalizeToolCallStatus('codex', 'started')).toBe('started')
    expect(normalizeToolCallStatus('claude', 'success')).toBe('success')
    expect(normalizeToolCallStatus('cursor', 'error')).toBe('error')
    expect(normalizeToolCallStatus('gemini', 'cancelled')).toBe('cancelled')
    expect(normalizeToolCallStatus('hermes', 'unknown')).toBe('unknown')
  })

  it('maps missing or unrecognized values to unknown', () => {
    expect(normalizeToolCallStatus('codex', null)).toBe('unknown')
    expect(normalizeToolCallStatus('gemini', 'pending')).toBe('unknown')
    expect(normalizeToolCallStatus('claude', '')).toBe('unknown')
  })

  it('normalizes Codex response and tool result statuses', () => {
    expect(normalizeToolCallStatus('codex', 'completed')).toBe('success')
    expect(normalizeToolCallStatus('codex', 'in_progress')).toBe('started')
    expect(normalizeToolCallStatus('codex', 'incomplete')).toBe('error')
    expect(normalizeToolCallStatus('codex', 'failed')).toBe('error')
    expect(normalizeToolCallStatus('codex', 'timeout')).toBe('error')
    expect(normalizeToolCallStatus('codex', 'canceled')).toBe('cancelled')
  })

  it('normalizes Hermes finish reasons', () => {
    expect(normalizeToolCallStatus('hermes', 'stop')).toBe('success')
    expect(normalizeToolCallStatus('hermes', 'tool_calls')).toBe('success')
    expect(normalizeToolCallStatus('hermes', 'length')).toBe('error')
    expect(normalizeToolCallStatus('hermes', 'content_filter')).toBe('error')
  })
})
