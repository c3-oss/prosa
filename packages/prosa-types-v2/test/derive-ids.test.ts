// CQ-006: deterministic source_file_id and raw_record_id derivation.

import { describe, expect, it } from 'vitest'

import { deriveRawRecordId, deriveSourceFileId } from '../src/canonical.js'

const TAG = (n: number) => `blake3:${n.toString(16).padStart(64, '0')}`

describe('deriveSourceFileId (CQ-006)', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveSourceFileId({
      source_tool: 'codex',
      path: '/repo/example/session.jsonl',
      content_hash: TAG(1),
    })
    const b = deriveSourceFileId({
      source_tool: 'codex',
      path: '/repo/example/session.jsonl',
      content_hash: TAG(1),
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^src_[a-z2-7]+$/)
  })

  it('changes when any input changes', () => {
    const base = {
      source_tool: 'codex',
      path: '/repo/example/session.jsonl',
      content_hash: TAG(1),
    }
    const a = deriveSourceFileId(base)
    expect(deriveSourceFileId({ ...base, source_tool: 'claude' })).not.toBe(a)
    expect(deriveSourceFileId({ ...base, path: '/repo/other/session.jsonl' })).not.toBe(a)
    expect(deriveSourceFileId({ ...base, content_hash: TAG(2) })).not.toBe(a)
  })

  it('rejects content_hash that is not in tagged-hash form', () => {
    expect(() => deriveSourceFileId({ source_tool: 'codex', path: '/x', content_hash: '0'.repeat(64) })).toThrow(
      /tagged-hash/,
    )
  })

  it('NFC-normalizes the path before hashing', () => {
    const nfd = 'café_NFD'.normalize('NFD')
    const nfc = 'café_NFD'.normalize('NFC')
    const a = deriveSourceFileId({ source_tool: 'codex', path: nfd, content_hash: TAG(1) })
    const b = deriveSourceFileId({ source_tool: 'codex', path: nfc, content_hash: TAG(1) })
    expect(a).toBe(b)
  })
})

describe('deriveRawRecordId (CQ-006)', () => {
  it('is deterministic for identical inputs', () => {
    const base = {
      source_tool: 'codex',
      source_file_id: 'src_a',
      ordinal: 0,
      record_kind: 'session_jsonl_line',
    }
    expect(deriveRawRecordId(base)).toBe(deriveRawRecordId(base))
    expect(deriveRawRecordId(base)).toMatch(/^raw_[a-z2-7]+$/)
  })

  it('changes when ordinal or kind changes', () => {
    const base = {
      source_tool: 'codex',
      source_file_id: 'src_a',
      ordinal: 0,
      record_kind: 'session_jsonl_line',
    }
    const a = deriveRawRecordId(base)
    expect(deriveRawRecordId({ ...base, ordinal: 1 })).not.toBe(a)
    expect(deriveRawRecordId({ ...base, record_kind: 'artifact_blob' })).not.toBe(a)
  })

  it('accepts bigint ordinals for sources beyond 2^53', () => {
    const a = deriveRawRecordId({
      source_tool: 'codex',
      source_file_id: 'src_a',
      ordinal: 0n,
      record_kind: 'session_jsonl_line',
    })
    expect(a).toMatch(/^raw_/)
  })

  it('rejects non-canonical source_file_id', () => {
    expect(() =>
      deriveRawRecordId({
        source_tool: 'codex',
        source_file_id: 'SRC_A',
        ordinal: 0,
        record_kind: 'session_jsonl_line',
      }),
    ).toThrow(/source_file_id/)
  })

  it('rejects negative ordinals', () => {
    expect(() =>
      deriveRawRecordId({
        source_tool: 'codex',
        source_file_id: 'src_a',
        ordinal: -1,
        record_kind: 'session_jsonl_line',
      }),
    ).toThrow(/ordinal/)
  })
})
