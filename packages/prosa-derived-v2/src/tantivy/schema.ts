// Tantivy local-index schema definition + fingerprint.
//
// The schema is pinned in TypeScript so the rebuild planner and the
// (future) Tantivy writer agree on the exact set of fields. Changes
// to this list bump `currentTantivySchemaFingerprint()` and force a
// full rebuild on next compile — see `./rebuild-plan.ts`.

import { blake3 } from '@noble/hashes/blake3'

import { toHex } from '@c3-oss/prosa-types-v2'

/** Per-field schema entry: name + Tantivy tokenizer to use. */
export interface TantivySchemaField {
  /** Tantivy-stored field name. */
  readonly name: string
  /** Tantivy tokenizer: `raw` for exact-match facet fields,
   *  `default` for natural-language tokenization. */
  readonly tokenizer: 'raw' | 'default'
}

/** Canonical Tantivy schema for prosa search documents.
 *
 * Order is part of the fingerprint contract — reordering bumps the
 * fingerprint and forces a full rebuild. */
export const TANTIVY_SCHEMA_FIELDS: readonly TantivySchemaField[] = [
  { name: 'doc_id', tokenizer: 'raw' },
  { name: 'entity_type', tokenizer: 'raw' },
  { name: 'entity_id', tokenizer: 'raw' },
  { name: 'session_id', tokenizer: 'raw' },
  { name: 'project_id', tokenizer: 'raw' },
  { name: 'timestamp', tokenizer: 'raw' },
  { name: 'role', tokenizer: 'raw' },
  { name: 'tool_name', tokenizer: 'raw' },
  { name: 'canonical_tool_type', tokenizer: 'raw' },
  { name: 'field_kind', tokenizer: 'raw' },
  // Natural-language tokenized — the only `default` tokenizer field.
  { name: 'text', tokenizer: 'default' },
] as const

/**
 * Stable fingerprint over the canonical schema. Used by the rebuild
 * planner to detect schema drift: a stored checkpoint with a
 * different fingerprint forces a full rebuild on next compile.
 *
 * Format: `blake3:<64-hex>` matching the rest of the v2 hash
 * conventions. The v1 implementation used SHA-256; the v2 port uses
 * blake3 to stay consistent with bundle / pack / receipt hashes —
 * the stored checkpoint compares fingerprints as opaque strings, so
 * the algorithm change is bundle-internal and never crosses the
 * wire.
 */
export function currentTantivySchemaFingerprint(): string {
  const canonical = TANTIVY_SCHEMA_FIELDS.map((f) => `${f.name}:${f.tokenizer}:stored`).join('|')
  return `blake3:${toHex(blake3(new TextEncoder().encode(canonical)))}`
}

/**
 * One row's worth of input to the Tantivy writer. Mirrors the v1
 * `SearchDocRow` shape against the v2 `SearchDocV2` projection.
 * Field-by-field optional/required parity is enforced so the
 * writer can call `addText` without `null` checks.
 */
export interface SearchDocInputV2 {
  rowid: number
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string | null
  project_id: string | null
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  text: string
}

/** Names of every field defined on the schema, in canonical order. */
export const TANTIVY_FIELD_NAMES: readonly string[] = TANTIVY_SCHEMA_FIELDS.map((f) => f.name)

/**
 * Normalise a `SearchDocInputV2` into a flat string map for the
 * Tantivy writer. `null` values land as empty strings; the field
 * order matches the schema so the writer can iterate over the
 * canonical list without re-deriving keys.
 */
export function toTantivyFieldMap(row: SearchDocInputV2): Record<string, string> {
  return {
    doc_id: row.doc_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    session_id: row.session_id ?? '',
    project_id: row.project_id ?? '',
    timestamp: row.timestamp ?? '',
    role: row.role ?? '',
    tool_name: row.tool_name ?? '',
    canonical_tool_type: row.canonical_tool_type ?? '',
    field_kind: row.field_kind,
    text: row.text,
  }
}
