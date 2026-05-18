// CQ-002: merkleLeaf rejects non-canonical timestamp / id / hash fields
// before encoding. Silent normalization would let two implementations
// produce different leaves from the same logical input.

import { describe, expect, it } from 'vitest'

import { canonicalTimestamp, merkleLeaf } from '../src/canonical.js'

function baselineSession(): Record<string, unknown> {
  return {
    session_id: 'ses_norm_001',
    source_tool: 'codex',
    source_session_id: 'src_ses_a',
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
  }
}

describe('CQ-002: merkleLeaf normalization enforcement', () => {
  it('accepts a fully canonical row', () => {
    expect(() => merkleLeaf('session', baselineSession() as never)).not.toThrow()
  })

  it('rejects timestamps with a non-Z offset', () => {
    const row = { ...baselineSession(), start_ts: '2025-01-02T03:04:05.123+00:00' }
    expect(() => merkleLeaf('session', row as never)).toThrow(/non-canonical timestamp/)
  })

  it('rejects timestamps with sub-ms precision', () => {
    const row = { ...baselineSession(), start_ts: '2025-01-02T03:04:05.123456Z' }
    expect(() => merkleLeaf('session', row as never)).toThrow(/non-canonical timestamp/)
  })

  it('rejects timestamps without fractional seconds', () => {
    const row = { ...baselineSession(), start_ts: '2025-01-02T03:04:05Z' }
    expect(() => merkleLeaf('session', row as never)).toThrow(/non-canonical timestamp/)
  })

  it('rejects impossible dates/times (CQ-014)', () => {
    const cases = [
      '2025-13-01T00:00:00.000Z',
      '2025-99-99T99:99:99.000Z',
      '2025-02-30T00:00:00.000Z',
      '2025-01-01T24:00:00.000Z',
      '2025-01-01T00:60:00.000Z',
      '2025-01-01T00:00:60.000Z',
    ]
    for (const ts of cases) {
      const row = { ...baselineSession(), start_ts: ts }
      expect(() => merkleLeaf('session', row as never), `expected reject for ${ts}`).toThrow(/non-canonical timestamp/)
    }
  })

  it('rejects non-canonical CAS object references in projection rows (CQ-010)', () => {
    const cases = ['obj_a01', 'not-a-hash', 'blake3:UPPERHEX', '0'.repeat(64)]
    for (const obj of cases) {
      const row = {
        artifact_id: 'art_001',
        session_id: 'ses_001',
        project_id: null,
        source_tool: 'codex',
        kind: 'file_write',
        path: '/tmp/x',
        logical_path: null,
        object_id: obj,
        text_object_id: null,
        mime_type: null,
        size_bytes: 0,
        created_ts: '2025-01-02T03:04:05.123Z',
        raw_record_id: 'raw_001',
      }
      expect(() => merkleLeaf('artifact', row as never), `expected reject for ${obj}`).toThrow(/tagged_hash|object_id/)
    }
  })

  it('accepts the output of canonicalTimestamp() for any RFC3339 input', () => {
    const cases = [
      '2025-01-02T03:04:05Z',
      '2025-01-02T03:04:05.999999Z',
      '2025-01-02T03:04:05+00:00',
      '2025-01-02T03:04:05.1Z',
    ]
    for (const c of cases) {
      const row = { ...baselineSession(), start_ts: canonicalTimestamp(c) }
      expect(() => merkleLeaf('session', row as never)).not.toThrow()
    }
  })

  it('rejects uppercase canonical IDs', () => {
    const row = { ...baselineSession(), session_id: 'SES_001' }
    expect(() => merkleLeaf('session', row as never)).toThrow(/non-canonical id/)
  })

  it('rejects IDs with whitespace or unsupported characters', () => {
    const cases = ['ses 001', 'ses/001', 'ses_001!', '/ses_001']
    for (const id of cases) {
      const row = { ...baselineSession(), session_id: id }
      expect(() => merkleLeaf('session', row as never)).toThrow(/non-canonical id/)
    }
  })

  it('rejects non-canonical tagged_hash values for raw_record.content_hash', () => {
    const row = {
      raw_record_id: 'raw_001',
      source_tool: 'codex',
      source_file_id: 'src_001',
      record_kind: 'session_jsonl_line',
      ordinal: 0,
      logical_offset: null,
      logical_length: null,
      line_no: null,
      json_pointer: null,
      parser_status: 'parsed',
      confidence: 'high',
      content_hash: 'blake3:UPPERCASEHEX',
      object_id: 'obj_r01',
      decoded_object_id: null,
      created_at: '2025-01-02T03:04:05.123Z',
    }
    expect(() => merkleLeaf('raw_record', row as never)).toThrow(/tagged_hash/)
  })

  it('rejects bare hex when the field expects tagged_hash', () => {
    const row = {
      raw_record_id: 'raw_001',
      source_tool: 'codex',
      source_file_id: 'src_001',
      record_kind: 'session_jsonl_line',
      ordinal: 0,
      logical_offset: null,
      logical_length: null,
      line_no: null,
      json_pointer: null,
      parser_status: 'parsed',
      confidence: 'high',
      content_hash: '0'.repeat(64),
      object_id: 'obj_r01',
      decoded_object_id: null,
      created_at: '2025-01-02T03:04:05.123Z',
    }
    expect(() => merkleLeaf('raw_record', row as never)).toThrow(/tagged_hash/)
  })

  it('rejects non-boolean booleans', () => {
    const row = { ...baselineSession(), is_subagent: 0 }
    expect(() => merkleLeaf('session', row as never)).toThrow(/boolean/)
  })

  it('rejects non-integer integers in canonical fields', () => {
    const row = {
      block_id: 'blk_001',
      message_id: null,
      event_id: null,
      session_id: 'ses_001',
      ordinal: 'first',
      block_type: 'text',
      text_object_id: null,
      text_inline: null,
      mime_type: null,
      token_count: null,
      is_error: false,
      is_redacted: false,
      visibility: 'default',
      raw_record_id: 'raw_001',
    }
    expect(() => merkleLeaf('content_block', row as never)).toThrow(/integer/)
  })
})
