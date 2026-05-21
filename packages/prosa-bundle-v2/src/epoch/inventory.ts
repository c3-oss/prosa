// Inline inventory segments — `inventory_object` and `inventory_projection`.
//
// `sealEpoch` produces two opaque inventory artifacts alongside the
// canonical pack/projection segments so the sync protocol has a wire-
// ready summary to upload. The server treats the bytes as opaque (it
// only checks the declared digest + presence in object storage), so we
// pick a stable JSON layout the materialization layer can decode
// later without committing to a binary frame format now.
//
// `inventory_object`: union of every CAS object the epoch publishes —
// the verified `casObjects` set on its own is not enough because the
// raw_source pack entries also live in CAS-addressable space via the
// `raw_source_pack` kind. We list both so sync can drive a single
// upload plan. `objectSetRoot` is the Merkle root over the sorted
// `object_id` list, which the server will recompute on receipt.
//
// `inventory_projection`: per-entity row totals and per-segment byte
// totals. Sync uses this to verify the projection materialization
// row count matches what the receipt claims.

import { join } from 'node:path'

import { blake3 } from '@noble/hashes/blake3'

import { type CanonicalEntityType, computeObjectId, merkleRoot, toHex } from '@c3-oss/prosa-types-v2'

import { writeFileDurable } from '../util/durable-write.js'
import type { DurableSegmentRef } from './lifecycle.js'

const utf8 = new TextEncoder()
const INVENTORY_OBJECT_FILE = 'inventory-object.bin'
const INVENTORY_PROJECTION_FILE = 'inventory-projection.bin'

export type ObjectInventoryEntry = {
  object_id: string
  origin: 'cas_object_pack' | 'raw_source_pack'
}

export type ObjectInventoryPayload = {
  format: 'prosa.inventory.object.v2'
  objects: ObjectInventoryEntry[]
  objectSetRoot: string
  totalObjects: number
}

export type ProjectionInventoryEntry = {
  segmentId: string
  digest: string
  entityType?: CanonicalEntityType
  byteLength: number
  rowCount?: number
}

export type ProjectionInventoryPayload = {
  format: 'prosa.inventory.projection.v2'
  byEntity: Partial<Record<CanonicalEntityType, number>>
  segments: ProjectionInventoryEntry[]
  totalRows: number
  totalBytes: number
}

export type BuildObjectInventoryInput = {
  casObjects: ReadonlySet<string>
  rawSourceContent: ReadonlySet<string>
}

export type BuildObjectInventoryResult = {
  bytes: Uint8Array
  payload: ObjectInventoryPayload
  digest: string
  objectSetRoot: string
}

/**
 * Build the `inventory_object` payload from the verified per-segment
 * data the seal walk produces. The byte layout is canonical JSON
 * (objects sorted by `object_id` ascending) so two consumers reading
 * the same bytes parse the same payload without drift.
 */
export function buildObjectInventory(input: BuildObjectInventoryInput): BuildObjectInventoryResult {
  const seen = new Set<string>()
  const entries: ObjectInventoryEntry[] = []
  for (const id of input.casObjects) {
    if (!seen.has(id)) {
      seen.add(id)
      entries.push({ object_id: id, origin: 'cas_object_pack' })
    }
  }
  for (const id of input.rawSourceContent) {
    if (!seen.has(id)) {
      seen.add(id)
      entries.push({ object_id: id, origin: 'raw_source_pack' })
    }
  }
  entries.sort((a, b) => (a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0))
  const ids = entries.map((e) => e.object_id)
  // Merkle root expects 32-byte leaves; hash each tagged id into a
  // domain-separated leaf so two inventories over the same set produce
  // the same root regardless of how the ids were originally encoded.
  const leaves = ids.map((id) => blake3(utf8.encode(`prosa.inventory.object.v2:${id}`)))
  const objectSetRoot = toHex(merkleRoot(leaves))
  const payload: ObjectInventoryPayload = {
    format: 'prosa.inventory.object.v2',
    objects: entries,
    objectSetRoot,
    totalObjects: entries.length,
  }
  const bytes = utf8.encode(JSON.stringify(payload))
  return { bytes, payload, digest: computeObjectId(bytes), objectSetRoot }
}

export type BuildProjectionInventoryInput = {
  /** Snapshot of registered projection segments before the inventory is registered. */
  segments: ReadonlyArray<{
    digest: string
    byteLength: number
    entityType?: CanonicalEntityType
    rowCount?: number
  }>
  /** Per-entity row counts taken from `EpochHandle.computeCounts()`. */
  countsByEntity: Partial<Record<CanonicalEntityType, number>>
}

export type BuildProjectionInventoryResult = {
  bytes: Uint8Array
  payload: ProjectionInventoryPayload
  digest: string
}

export function buildProjectionInventory(input: BuildProjectionInventoryInput): BuildProjectionInventoryResult {
  const segments: ProjectionInventoryEntry[] = input.segments
    .slice()
    .sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0))
    .map((s) => {
      const entry: ProjectionInventoryEntry = {
        segmentId: `seg_${s.digest.replace(/^blake3:/, '').slice(0, 16)}`,
        digest: s.digest,
        byteLength: s.byteLength,
      }
      if (s.entityType !== undefined) entry.entityType = s.entityType
      if (s.rowCount !== undefined) entry.rowCount = s.rowCount
      return entry
    })
  let totalRows = 0
  for (const v of Object.values(input.countsByEntity)) totalRows += v ?? 0
  let totalBytes = 0
  for (const s of segments) totalBytes += s.byteLength
  const payload: ProjectionInventoryPayload = {
    format: 'prosa.inventory.projection.v2',
    byEntity: input.countsByEntity,
    segments,
    totalRows,
    totalBytes,
  }
  const bytes = utf8.encode(JSON.stringify(payload))
  return { bytes, payload, digest: computeObjectId(bytes) }
}

export type WriteInventorySegmentsInput = {
  tmpEpochDir: string
  objectInventoryBytes: Uint8Array
  projectionInventoryBytes: Uint8Array
  objectSetRoot: string
  objectCount: number
  projectionRowCount: number
}

export type WriteInventorySegmentsResult = {
  objectRef: DurableSegmentRef
  projectionRef: DurableSegmentRef
}

/**
 * Write both inventory files to the epoch tmp dir and return ref shapes
 * the caller can pass to `EpochHandle.registerSegment`. `seg_` ids are
 * derived from the digest's first 16 hex chars so re-running the
 * computation on identical inputs yields identical ids.
 */
export async function writeInventorySegments(
  input: WriteInventorySegmentsInput,
): Promise<WriteInventorySegmentsResult> {
  const objectPath = join(input.tmpEpochDir, INVENTORY_OBJECT_FILE)
  const projectionPath = join(input.tmpEpochDir, INVENTORY_PROJECTION_FILE)
  const objectDigest = computeObjectId(input.objectInventoryBytes)
  const projectionDigest = computeObjectId(input.projectionInventoryBytes)
  await writeFileDurable(objectPath, input.objectInventoryBytes)
  await writeFileDurable(projectionPath, input.projectionInventoryBytes)
  const objectRef: DurableSegmentRef = {
    kind: 'inventory_object',
    path: objectPath,
    digest: objectDigest,
    byteLength: input.objectInventoryBytes.length,
    objectCount: input.objectCount,
    objectSetRoot: input.objectSetRoot,
    segmentId: `seg_${objectDigest.replace(/^blake3:/, '').slice(0, 16)}`,
  }
  const projectionRef: DurableSegmentRef = {
    kind: 'inventory_projection',
    path: projectionPath,
    digest: projectionDigest,
    byteLength: input.projectionInventoryBytes.length,
    rowCount: input.projectionRowCount,
    segmentId: `seg_${projectionDigest.replace(/^blake3:/, '').slice(0, 16)}`,
  }
  return { objectRef, projectionRef }
}

export { INVENTORY_OBJECT_FILE, INVENTORY_PROJECTION_FILE }
