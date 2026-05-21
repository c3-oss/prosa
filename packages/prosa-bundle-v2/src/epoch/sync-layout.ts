// `sync-v2.layout.json` writer.
//
// `apps/cli/src/cli/commands/sync-v2.ts:102-133` reads this file to find
// the inventories + object packs it needs to push to the API. Before
// this module existed, only the e2e test fabricated the layout
// manually, so production `sync-v2` could never promote a real
// compile-v2 bundle. `sealEpoch` calls `writeSyncLayoutFile` after the
// epoch dir is published so every sealed bundle is wire-ready.

import { isAbsolute, relative } from 'node:path'

import { writeFileDurable } from '../util/durable-write.js'
import type { DurableSegmentRef } from './lifecycle.js'

export type SyncLayoutInventoryEntry = {
  ref: SyncLayoutRef
  /** Path relative to the bundle root. */
  file: string
}

export type SyncLayoutObjectPackEntry = {
  /** Path relative to the bundle root. */
  file: string
}

export type SyncLayoutRef = {
  segmentId: string
  kind: 'inventory_object' | 'inventory_projection'
  digest: string
  logicalRoot: string
  compression: 'zstd' | 'none'
  byteLength: number
  objectCount?: number
  objectSetRoot?: string
  rowCount?: number
}

export type SyncLayoutV2 = {
  storePath: string
  objectInventory: SyncLayoutInventoryEntry
  projectionInventory: SyncLayoutInventoryEntry
  objectPacks: SyncLayoutObjectPackEntry[]
}

export const SYNC_LAYOUT_FILE_NAME = 'sync-v2.layout.json'

export type WriteSyncLayoutInput = {
  bundleRoot: string
  storePath: string
  objectInventory: DurableSegmentRef
  projectionInventory: DurableSegmentRef
  /** Every `cas_object_pack` segment registered for this epoch. Order does not matter. */
  objectPacks: ReadonlyArray<{ path: string }>
}

/**
 * Write `<bundleRoot>/sync-v2.layout.json` with paths normalised
 * relative to the bundle root so the file is portable across hosts
 * (the CLI re-joins each entry against the bundle root at upload
 * time).
 */
export async function writeSyncLayoutFile(input: WriteSyncLayoutInput): Promise<void> {
  const layout: SyncLayoutV2 = {
    storePath: input.storePath,
    objectInventory: {
      ref: toLayoutRef(input.objectInventory),
      file: toRelative(input.bundleRoot, input.objectInventory.path),
    },
    projectionInventory: {
      ref: toLayoutRef(input.projectionInventory),
      file: toRelative(input.bundleRoot, input.projectionInventory.path),
    },
    objectPacks: input.objectPacks.map((p) => ({ file: toRelative(input.bundleRoot, p.path) })),
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(layout, null, 2)}\n`)
  await writeFileDurable(`${input.bundleRoot}/${SYNC_LAYOUT_FILE_NAME}`, bytes)
}

function toRelative(bundleRoot: string, target: string): string {
  if (!isAbsolute(target)) return target
  const rel = relative(bundleRoot, target)
  // Refuse to emit a path that escapes the bundle root; the seal owns
  // every artifact referenced by the layout, so an upward relative
  // path is a bug, not a config option.
  if (rel.startsWith('..')) {
    throw new Error(`sync-v2.layout: ${target} is not inside bundle root ${bundleRoot}`)
  }
  return rel
}

function toLayoutRef(ref: DurableSegmentRef): SyncLayoutRef {
  if (ref.kind !== 'inventory_object' && ref.kind !== 'inventory_projection') {
    throw new Error(`sync-v2.layout: unexpected ref kind ${ref.kind} for inventory entry`)
  }
  const segmentId = ref.segmentId ?? `seg_${ref.digest.replace(/^blake3:/, '').slice(0, 16)}`
  const out: SyncLayoutRef = {
    segmentId,
    kind: ref.kind,
    digest: ref.digest,
    logicalRoot: ref.kind === 'inventory_object' ? 'objects/inv' : 'projection/inv',
    compression: 'zstd',
    byteLength: ref.byteLength,
  }
  if (ref.objectCount !== undefined) out.objectCount = ref.objectCount
  if (ref.objectSetRoot !== undefined) out.objectSetRoot = ref.objectSetRoot
  if (ref.rowCount !== undefined) out.rowCount = ref.rowCount
  return out
}
