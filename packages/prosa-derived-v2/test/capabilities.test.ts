// Tests for `derivedLayerCapabilities`.

import { describe, expect, it } from 'vitest'

import { ANALYTICS_ENTITY_TABLES, ANALYTICS_VIEW_NAMES } from '../src/analytics/views.js'
import { derivedLayerCapabilities } from '../src/capabilities.js'
import {
  COMPACTION_FILE_COUNT_TRIGGER,
  COMPACTION_LOW_COUNT_BYTE_CEILING,
  COMPACTION_LOW_COUNT_TRIGGER,
  SMALL_SEGMENT_BYTES,
} from '../src/compaction/policy.js'
import { TANTIVY_SCHEMA_FIELDS, currentTantivySchemaFingerprint } from '../src/tantivy/schema.js'

describe('derivedLayerCapabilities', () => {
  it('pins the compact-manifest schema discriminator', () => {
    expect(derivedLayerCapabilities().schema_ids.compact_manifest).toBe('prosa.compact-manifest.v2')
  })

  it('emits the canonical compaction fire-reason enum + every policy threshold', () => {
    const caps = derivedLayerCapabilities().compaction
    expect(caps.fire_reasons).toEqual(['file_count_trigger', 'low_count_byte_ceiling'])
    expect(caps.small_segment_bytes).toBe(SMALL_SEGMENT_BYTES)
    expect(caps.file_count_trigger).toBe(COMPACTION_FILE_COUNT_TRIGGER)
    expect(caps.low_count_trigger).toBe(COMPACTION_LOW_COUNT_TRIGGER)
    expect(caps.low_count_byte_ceiling).toBe(COMPACTION_LOW_COUNT_BYTE_CEILING)
  })

  it('echoes the canonical analytics entity tables and view names', () => {
    const caps = derivedLayerCapabilities().analytics
    expect(caps.entity_tables).toEqual(ANALYTICS_ENTITY_TABLES)
    expect(caps.view_names).toEqual(ANALYTICS_VIEW_NAMES)
  })

  it('emits the current tantivy schema fingerprint and the full field list', () => {
    const caps = derivedLayerCapabilities().tantivy
    expect(caps.schema_fingerprint).toBe(currentTantivySchemaFingerprint())
    expect(caps.field_names).toEqual(TANTIVY_SCHEMA_FIELDS.map((f) => f.name))
    expect(caps.fields).toEqual(TANTIVY_SCHEMA_FIELDS)
  })

  it('is deterministic across calls (same shape, same fingerprint)', () => {
    const a = derivedLayerCapabilities()
    const b = derivedLayerCapabilities()
    expect(a).toEqual(b)
    expect(a.tantivy.schema_fingerprint).toBe(b.tantivy.schema_fingerprint)
  })

  it('returns a JSON-serialisable shape (no functions, no symbols)', () => {
    const caps = derivedLayerCapabilities()
    expect(() => JSON.stringify(caps)).not.toThrow()
    const round = JSON.parse(JSON.stringify(caps)) as ReturnType<typeof derivedLayerCapabilities>
    expect(round).toEqual(caps)
  })
})
