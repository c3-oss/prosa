// Projection segment writer.
//
// One canonical segment per entity type per epoch. Rows are sorted by
// primary key ASC bytewise (matching the canonical Merkle sort order) and
// emitted as canonical-JSON one-per-line (NDJSON) framed by a small
// JSON-encoded header. The segment file ends in `.prosa-projection.ndjson`
// so it's distinguishable from arbitrary newline-delimited data.
//
// Lane 1 deliberately uses canonical NDJSON instead of Parquet: the same
// rule layer (canonical-JSON sort + BLAKE3 over the file bytes) is what
// the wire layer hashes anyway, so we keep the round-trip property
// without dragging in DuckDB's Parquet emit path. A follow-up iteration
// can swap the bytes for Parquet while keeping the segment-writer
// signature identical.

import { join } from 'node:path'

import { type CanonicalEntityType, type CborValue, ENTITY_PRIMARY_KEY, toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import type { DurableSegmentRef } from '../epoch/lifecycle.js'
import { canonicalJsonString } from '../pack/framing.js'
import { writeFileDurable } from '../util/durable-write.js'

export type ProjectionSegmentWriteOptions = {
  /** Bundle root directory; the writer puts files under `<root>/epochs/<epoch>/projection/`.
   * Use the EpochHandle's tmpDir for in-progress writes so the seal-time rename
   * stays atomic. */
  outDir: string
}

export type ProjectionSegmentWriteResult = {
  ref: DurableSegmentRef
  /** Number of rows written. */
  rowCount: number
}

/**
 * Write a projection segment for one entity type. Rows are sorted by
 * primary key (per CANONICAL.md rule 7) and emitted as canonical NDJSON.
 * The returned `DurableSegmentRef` is ready to pass to
 * `EpochHandle.registerSegment(...)`.
 */
export async function writeProjectionSegment(
  entityType: CanonicalEntityType,
  rows: readonly Record<string, CborValue>[],
  options: ProjectionSegmentWriteOptions,
): Promise<ProjectionSegmentWriteResult> {
  const pk = ENTITY_PRIMARY_KEY[entityType]
  const sorted = [...rows].sort((a, b) => {
    const ak = (a[pk] as string) ?? ''
    const bk = (b[pk] as string) ?? ''
    return compareBytewise(ak, bk)
  })
  const header = canonicalJsonString({
    bundleFormat: 2,
    segmentKind: 'projection_ndjson',
    entityType,
    rowCount: sorted.length,
  })
  const lines: string[] = [header]
  for (const row of sorted) {
    lines.push(canonicalJsonString(row))
  }
  const body = `${lines.join('\n')}\n`
  const bytes = new TextEncoder().encode(body)
  const digest = `blake3:${toHex(blake3(bytes))}`

  const dir = join(options.outDir, 'projection')
  const filename = `${entityType}.prosa-projection.ndjson`
  const path = join(dir, filename)
  await writeFileDurable(path, bytes)

  const ref: DurableSegmentRef = {
    kind: 'projection_arrow',
    path,
    digest,
    byteLength: bytes.length,
    entityType,
  }
  return { ref, rowCount: sorted.length }
}

/**
 * Convenience: write segments for every entity type that has at least
 * one row in `rowsByEntity`. Returns the list of refs to register on the
 * EpochHandle. Empty-row entity types are skipped.
 */
export async function writeAllProjectionSegments(
  rowsByEntity: Partial<Record<CanonicalEntityType, readonly Record<string, CborValue>[]>>,
  options: ProjectionSegmentWriteOptions,
): Promise<ProjectionSegmentWriteResult[]> {
  const out: ProjectionSegmentWriteResult[] = []
  const entries = Object.entries(rowsByEntity) as [CanonicalEntityType, readonly Record<string, CborValue>[]][]
  for (const [et, rows] of entries) {
    if (!rows || rows.length === 0) continue
    out.push(await writeProjectionSegment(et, rows, options))
  }
  return out
}

function compareBytewise(a: string, b: string): number {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  const len = Math.min(ab.length, bb.length)
  for (let i = 0; i < len; i++) {
    const av = ab[i] as number
    const bv = bb[i] as number
    if (av !== bv) return av - bv
  }
  return ab.length - bb.length
}
