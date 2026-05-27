// Tantivy schema + fingerprint tests.

import { describe, expect, it } from 'vitest'

import {
  TANTIVY_FIELD_NAMES,
  TANTIVY_SCHEMA_FIELDS,
  currentTantivySchemaFingerprint,
  toTantivyFieldMap,
} from '../../src/tantivy/schema.js'

describe('TANTIVY_SCHEMA_FIELDS', () => {
  it('locks the canonical schema field order', () => {
    expect(TANTIVY_FIELD_NAMES).toEqual([
      'doc_id',
      'entity_type',
      'entity_id',
      'session_id',
      'project_id',
      'timestamp',
      'role',
      'tool_name',
      'canonical_tool_type',
      'field_kind',
      'text',
    ])
  })

  it('only `text` uses the natural-language tokenizer; everything else is raw', () => {
    for (const field of TANTIVY_SCHEMA_FIELDS) {
      if (field.name === 'text') expect(field.tokenizer).toBe('default')
      else expect(field.tokenizer).toBe('raw')
    }
  })

  it('schema fields have no duplicates', () => {
    const names = TANTIVY_SCHEMA_FIELDS.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('currentTantivySchemaFingerprint', () => {
  it('returns a `blake3:<64-hex>` digest', () => {
    const fp = currentTantivySchemaFingerprint()
    expect(fp).toMatch(/^blake3:[0-9a-f]{64}$/)
  })

  it('is deterministic — same canonical schema produces byte-identical fingerprint', () => {
    const a = currentTantivySchemaFingerprint()
    const b = currentTantivySchemaFingerprint()
    expect(a).toBe(b)
  })
})

describe('toTantivyFieldMap', () => {
  it('coerces nullable fields to empty strings', () => {
    const map = toTantivyFieldMap({
      rowid: 1,
      doc_id: 'd_1',
      entity_type: 'message',
      entity_id: 'm_1',
      session_id: null,
      project_id: null,
      timestamp: null,
      role: null,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: 'user_prompt',
      text: 'hello',
    })
    expect(map).toEqual({
      doc_id: 'd_1',
      entity_type: 'message',
      entity_id: 'm_1',
      session_id: '',
      project_id: '',
      timestamp: '',
      role: '',
      tool_name: '',
      canonical_tool_type: '',
      field_kind: 'user_prompt',
      text: 'hello',
    })
  })

  it('passes through non-null values verbatim', () => {
    const map = toTantivyFieldMap({
      rowid: 2,
      doc_id: 'd_2',
      entity_type: 'tool_call',
      entity_id: 'tc_2',
      session_id: 'ses_2',
      project_id: 'proj_2',
      timestamp: '2026-05-19T01:00:00.000Z',
      role: 'assistant',
      tool_name: 'bash',
      canonical_tool_type: 'shell',
      field_kind: 'tool_command',
      text: 'ls /repo',
    })
    expect(map.session_id).toBe('ses_2')
    expect(map.tool_name).toBe('bash')
    expect(map.timestamp).toBe('2026-05-19T01:00:00.000Z')
  })
})
