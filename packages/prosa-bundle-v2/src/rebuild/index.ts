// Cold rebuild: reconstruct the per-shard index logs from sealed
// projection segments + the raw-source manifest in each epoch.
//
// Flow:
//   1. Read every `epochs/<n>/projection/*.prosa-projection.ndjson` plus
//      the signed epoch manifest under `epochs/<n>/`.
//   2. For every projection row whose entity type has a keyspace
//      (session, raw_record, source_file, project, edge — plus `object`
//      synthesized from raw-source entries), compute its shard via
//      `shardOf(keyspace, key)` and append a PutIfAbsent log entry to
//      the per-shard scratch log in `tmp/index-rebuild-<uuid>/`.
//   3. Write `rebuild.manifest` summarising what was reconstructed
//      (epochs walked, per-shard / per-keyspace counts).
//   4. Atomically rename `index/` → `index-old-<timestamp>/` and the
//      scratch dir → `index/`. The new `Bundle.open()` (or a follow-up
//      Bundle.openWithShards) opens persistent shards against the new
//      logs.
//
// Crash safety: any `tmp/index-rebuild-*` directory without a complete
// `rebuild.manifest` is treated as stale and reaped by `reapStaleTmp`
// (already wired into `Bundle.open()`).

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type CanonicalEntityType,
  ENTITY_PRIMARY_KEY,
  base32LowerNoPad,
  canonicalTimestamp,
} from '@c3-oss/prosa-types-v2'

import type { Bundle } from '../bundle/bundle.js'
import { indexOldDir, indexRebuildDir } from '../bundle/layout.js'
import type { Keyspace } from '../shard/commands.js'
import { SHARD_COUNT, shardOf } from '../shard/sharding.js'

// Entity types that map to a shard keyspace. Other entity types
// (turn / event / message / content_block / tool_call / tool_result /
// artifact / search_doc) are derived projections that do not own
// uniqueness keys at the shard layer.
const KEYSPACE_FOR_ENTITY: Partial<Record<CanonicalEntityType, Keyspace>> = {
  session: 'session',
  raw_record: 'raw_record',
  source_file: 'source_file',
  project: 'project',
  edge: 'edge',
}

export type RebuildIndexOptions = {
  /** Override the UUID used in the scratch directory name (tests). */
  uuid?: string
  /** Override `Date.now` for the index-old timestamp (tests). */
  now?: () => Date
}

export type RebuildManifest = {
  rebuildVersion: 1
  storeId: string
  rebuiltAt: string
  uuid: string
  epochsWalked: number[]
  shardCount: number
  totalRowsByKeyspace: Record<string, number>
  perShardCounts: number[]
}

export type RebuildIndexResult = {
  manifest: RebuildManifest
  /** Path to the newly-installed `index/` directory. */
  newIndexDir: string
  /** Path the old `index/` was renamed to (null when the old dir was empty). */
  archivedAt: string | null
}

/**
 * Reconstruct the per-shard append-log index from sealed epoch
 * projection segments. The resulting `index/` contains
 * `shard-NN.log` files compatible with `MemoryShardActor.openPersistent`.
 */
export async function rebuildIndex(bundle: Bundle, options: RebuildIndexOptions = {}): Promise<RebuildIndexResult> {
  const uuid = options.uuid ?? base32LowerNoPad(randomBytes(8))
  const scratch = indexRebuildDir(bundle.paths.root, uuid)
  await mkdir(scratch, { recursive: true })

  // Lazy per-shard write buffer.
  const shardLines: Map<number, string[]> = new Map()
  const counts: Record<string, number> = {}

  const recordEntry = (keyspace: Keyspace, key: string, value: unknown): void => {
    const keyBytes = new TextEncoder().encode(key)
    const shard = shardOf(keyspace, keyBytes)
    let lines = shardLines.get(shard)
    if (!lines) {
      lines = []
      shardLines.set(shard, lines)
    }
    const valueB64 = Buffer.from(new TextEncoder().encode(JSON.stringify(value))).toString('base64')
    const keyHex = bytesToHex(keyBytes)
    lines.push(JSON.stringify({ op: 'put_if_absent', keyspace, key: keyHex, value: valueB64 }))
    counts[keyspace] = (counts[keyspace] ?? 0) + 1
  }

  const epochs = await listSealedEpochs(bundle)

  for (const epoch of epochs) {
    const projDir = join(bundle.paths.root, 'epochs', String(epoch), 'projection')
    let segments: string[]
    try {
      segments = await readdir(projDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    for (const filename of segments) {
      if (!filename.endsWith('.prosa-projection.ndjson')) continue
      const entityType = filename.replace(/\.prosa-projection\.ndjson$/u, '') as CanonicalEntityType
      const keyspace = KEYSPACE_FOR_ENTITY[entityType]
      if (!keyspace) continue
      const pkField = ENTITY_PRIMARY_KEY[entityType]
      const raw = await readFile(join(projDir, filename), 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      // First line is the header; skip it.
      for (let i = 1; i < lines.length; i++) {
        const row = JSON.parse(lines[i] as string) as Record<string, unknown>
        const key = row[pkField] as string | undefined
        if (typeof key !== 'string' || key.length === 0) continue
        recordEntry(keyspace, key, row)
      }
    }
  }

  // Write per-shard scratch logs.
  const perShardCounts: number[] = Array.from({ length: SHARD_COUNT }, () => 0)
  for (let shard = 0; shard < SHARD_COUNT; shard++) {
    const lines = shardLines.get(shard) ?? []
    const path = join(scratch, `shard-${String(shard).padStart(2, '0')}.log`)
    await writeFile(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
    perShardCounts[shard] = lines.length
  }

  const rebuiltAt = canonicalTimestamp((options.now?.() ?? new Date()).toISOString())
  const manifest: RebuildManifest = {
    rebuildVersion: 1,
    storeId: bundle.head.storeId,
    rebuiltAt,
    uuid,
    epochsWalked: epochs,
    shardCount: SHARD_COUNT,
    totalRowsByKeyspace: counts,
    perShardCounts,
  }
  await writeFile(join(scratch, 'rebuild.manifest'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Atomic install: rename old index/ → index-old-<ts>/ (if any), then
  // rename scratch → index/.
  let archivedAt: string | null = null
  const indexStat = await stat(bundle.paths.index).catch(() => null)
  if (indexStat?.isDirectory()) {
    const stamp = rebuiltAt.replace(/[:.]/g, '-')
    archivedAt = indexOldDir(bundle.paths.root, stamp)
    await rename(bundle.paths.index, archivedAt)
  }
  await rename(scratch, bundle.paths.index)
  return { manifest, newIndexDir: bundle.paths.index, archivedAt }
}

async function listSealedEpochs(bundle: Bundle): Promise<number[]> {
  let entries: string[]
  try {
    entries = await readdir(bundle.paths.epochs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: number[] = []
  for (const name of entries) {
    const n = Number.parseInt(name, 10)
    if (!Number.isNaN(n) && n >= 0) out.push(n)
  }
  out.sort((a, b) => a - b)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
