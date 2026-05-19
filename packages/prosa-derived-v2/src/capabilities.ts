// Derived-layer capability snapshot — pure introspection.
//
// Downstream tools (MCP servers, web dashboards, CLI plumbing,
// downstream parsers) want a single stable shape that answers
// "what does this binary's derived layer support?". Instead of
// stitching together `analyticsViewsDescriptor` +
// `currentTantivySchemaFingerprint` + a hand-rolled compaction
// reason enum + manifest schema string, this module emits the
// whole bundle in one call.
//
// Pure function — no parameters, no filesystem touch, no
// allocations beyond the result. The fingerprint is recomputed
// each call (it is a constant in practice), so the function is
// safe to call from hot paths.
//
// The shape is intentionally flat-by-subsystem so each capability
// stays scoped to its owner and so version bumps localise to the
// subsystem that changed.

import { ANALYTICS_ENTITY_TABLES, ANALYTICS_VIEW_NAMES } from './analytics/views.js'
import {
  COMPACTION_FILE_COUNT_TRIGGER,
  COMPACTION_LOW_COUNT_BYTE_CEILING,
  COMPACTION_LOW_COUNT_TRIGGER,
  type CompactionFireReason,
  SMALL_SEGMENT_BYTES,
} from './compaction/policy.js'
import { TANTIVY_SCHEMA_FIELDS, type TantivySchemaField } from './tantivy/schema.js'
import { currentTantivySchemaFingerprint } from './tantivy/schema.js'

/** Stable string discriminators for every persisted derived-layer
 *  artifact. Downstream parsers pin against this list and reject
 *  files whose discriminator does not match. */
export interface DerivedLayerSchemaIds {
  /** `compact.manifest.json` schema discriminator. */
  compact_manifest: 'prosa.compact-manifest.v2'
}

export interface CompactionCapabilities {
  /** Every fire-reason the planner can emit. Downstream consumers
   *  switch on this enum. */
  fire_reasons: readonly CompactionFireReason[]
  /** Inclusive byte ceiling for "small" segments — the threshold
   *  the planner uses to filter candidates. */
  small_segment_bytes: number
  /** Hard fire threshold: >= this many small segments per entity
   *  → fire. */
  file_count_trigger: number
  /** Low-count fire threshold: 16 < count <= 32 small segments
   *  AND combined bytes <= `low_count_byte_ceiling` → fire. */
  low_count_trigger: number
  /** Combined-byte ceiling for the low-count trigger. */
  low_count_byte_ceiling: number
}

export interface AnalyticsCapabilities {
  /** Canonical entity tables exposed in the analytics view set. */
  entity_tables: readonly string[]
  /** Named SQL views the executor can run. */
  view_names: readonly string[]
}

export interface TantivyCapabilities {
  /** BLAKE3 fingerprint of the canonical schema field list. Used
   *  by the rebuild planner to detect schema drift. */
  schema_fingerprint: string
  /** Ordered list of every field name in the canonical schema. */
  field_names: readonly string[]
  /** Full per-field schema records (name + type + options) for
   *  consumers that need the raw shape. */
  fields: readonly TantivySchemaField[]
}

export interface DerivedLayerCapabilities {
  schema_ids: DerivedLayerSchemaIds
  compaction: CompactionCapabilities
  analytics: AnalyticsCapabilities
  tantivy: TantivyCapabilities
}

/**
 * Emit the full derived-layer capability snapshot.
 *
 * The result is content-free and deterministic — calling this in a
 * loop returns equal values (BLAKE3 fingerprint over a constant
 * schema). Downstream tools should treat the shape as stable
 * across patch releases of `@c3-oss/prosa-derived-v2` and check
 * `schema_ids.*` to confirm format alignment with the persisted
 * artifacts.
 */
export function derivedLayerCapabilities(): DerivedLayerCapabilities {
  return {
    schema_ids: {
      compact_manifest: 'prosa.compact-manifest.v2',
    },
    compaction: {
      fire_reasons: ['file_count_trigger', 'low_count_byte_ceiling'],
      small_segment_bytes: SMALL_SEGMENT_BYTES,
      file_count_trigger: COMPACTION_FILE_COUNT_TRIGGER,
      low_count_trigger: COMPACTION_LOW_COUNT_TRIGGER,
      low_count_byte_ceiling: COMPACTION_LOW_COUNT_BYTE_CEILING,
    },
    analytics: {
      entity_tables: ANALYTICS_ENTITY_TABLES,
      view_names: ANALYTICS_VIEW_NAMES,
    },
    tantivy: {
      schema_fingerprint: currentTantivySchemaFingerprint(),
      field_names: TANTIVY_SCHEMA_FIELDS.map((f) => f.name),
      fields: TANTIVY_SCHEMA_FIELDS,
    },
  }
}
