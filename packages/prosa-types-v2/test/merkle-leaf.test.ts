import { describe, expect, it } from 'vitest'

import { merkleLeaf, toHex } from '../src/canonical.js'

describe('merkleLeaf', () => {
  const sessionRow = {
    session_id: 'ses_abc',
    source_tool: 'codex',
    source_session_id: 'codex_xyz',
    project_id: null,
    parent_session_id: null,
    parent_resolution: 'unresolved',
    is_subagent: false,
    agent_role: null,
    agent_nickname: null,
    title: null,
    summary: null,
    start_ts: '2025-01-02T03:04:05.123Z',
    end_ts: null,
    cwd_initial: null,
    git_branch_initial: null,
    model_first: null,
    model_last: null,
    status: null,
    timeline_confidence: 'high',
    raw_record_id: null,
  } as const

  it('produces deterministic 32-byte output', () => {
    const a = merkleLeaf('session', sessionRow)
    const b = merkleLeaf('session', sessionRow)
    expect(a.length).toBe(32)
    expect(toHex(a)).toBe(toHex(b))
  })

  it('changes the leaf when any field changes', () => {
    const baseline = merkleLeaf('session', sessionRow)
    const mutated = merkleLeaf('session', { ...sessionRow, title: 'changed' })
    expect(toHex(mutated)).not.toBe(toHex(baseline))
  })

  it('changes the leaf when entity_type changes (domain separation)', () => {
    const a = merkleLeaf('session', sessionRow)
    const altRow = { ...sessionRow, project_id: 'ses_abc' }
    // Project requires its own primary key field; build a synthetic row.
    const projectRow = {
      project_id: 'ses_abc',
      canonical_path: null,
      path_hash: null,
      source_tool: null,
      source_project_id: null,
      display_name: null,
      created_at: '2025-01-02T03:04:05.123Z',
    }
    const b = merkleLeaf('project', projectRow)
    expect(toHex(a)).not.toBe(toHex(b))
    // also independent of altRow access
    expect(altRow.project_id).toBe('ses_abc')
  })

  it('throws if the primary key field is missing', () => {
    expect(() => merkleLeaf('session', { ...sessionRow, session_id: undefined as unknown as string })).toThrow(
      /primary key/,
    )
  })

  it('accepts mixed-case external ids on source_*_id fields (regression)', () => {
    // Regression: source_message_id / source_call_id / etc. carry the
    // external tool's id verbatim (Claude `msg_0158LWs9...`, OpenAI
    // `call_XhfaCqYd...`). When these fields were typed as the
    // canonical-id kind, `validateFieldValue` rejected any value with
    // uppercase characters, blocking real codex/claude compiles at
    // seal time. They are now declared as plain strings.
    const messageRow = {
      message_id: 'msg_abc123',
      session_id: 'ses_abc',
      turn_id: null,
      event_id: null,
      source_message_id: 'msg_0158LWs9utihf4Sf9eQf4omQ',
      role: 'assistant',
      author_name: null,
      model: null,
      timestamp: '2025-01-02T03:04:05.123Z',
      ordinal: 0,
      parent_message_id: null,
      request_id: 'req_AbCdEf01ZyXw',
      status: null,
      raw_record_id: 'rrec_abc',
    } as const
    expect(() => merkleLeaf('message', messageRow)).not.toThrow()

    const toolCallRow = {
      tool_call_id: 'tc_abc',
      session_id: 'ses_abc',
      turn_id: null,
      message_id: null,
      event_id: null,
      source_call_id: 'call_XhfaCqYdmFaEDU9Y2kH6h4Oo',
      tool_name: 'bash',
      canonical_tool_type: 'shell',
      args_object_id: null,
      command: null,
      cwd: null,
      path: null,
      query: null,
      timestamp_start: '2025-01-02T03:04:05.123Z',
      timestamp_end: null,
      status: null,
      raw_record_id: 'rrec_abc',
    } as const
    expect(() => merkleLeaf('tool_call', toolCallRow)).not.toThrow()
  })

  it('respects field ordering', () => {
    // Re-order fields in input: the leaf must be unchanged because
    // canonical_cbor pulls fields in schema order.
    const reorderedKeys = Object.keys(sessionRow).reverse()
    const reordered = Object.fromEntries(
      reorderedKeys.map((k) => [k, (sessionRow as Record<string, unknown>)[k]]),
    ) as typeof sessionRow
    expect(toHex(merkleLeaf('session', reordered))).toBe(toHex(merkleLeaf('session', sessionRow)))
  })
})
