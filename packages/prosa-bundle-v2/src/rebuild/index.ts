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
import { mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type CanonicalEntityType,
  ENTITY_PRIMARY_KEY,
  base32LowerNoPad,
  canonicalTimestamp,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import type { Bundle } from '../bundle/bundle.js'
import { indexOldDir, indexRebuildDir } from '../bundle/layout.js'
import type { Keyspace } from '../shard/commands.js'
import { SHARD_COUNT, shardOf } from '../shard/sharding.js'
import { syncDir, writeFileDurable } from '../util/durable-write.js'

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

export class RebuildIntegrityError extends Error {
  override name = 'RebuildIntegrityError'
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
    // CQ-043: load the epoch manifest so we can verify segment digests
    // before consuming them. A drifted projection file would otherwise
    // corrupt the rebuilt index silently.
    const expectedDigests = await loadProjectionDigests(bundle, epoch)
    const projDir = join(bundle.paths.root, 'epochs', String(epoch), 'projection')
    let segments: string[]
    try {
      segments = await readdir(projDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
    // CQ-046 step 1: verify every projection segment file against the
    // manifest's declared digest. An extra segment file not declared
    // in the manifest is rejected. An indexed (keyspace) segment is
    // also replayed into the per-shard log; non-keyspace segments are
    // verified only.
    for (const filename of segments) {
      if (!filename.endsWith('.prosa-projection.ndjson')) continue
      const entityType = filename.replace(/\.prosa-projection\.ndjson$/u, '') as CanonicalEntityType
      const segPath = join(projDir, filename)
      const rawBytes = await readFile(segPath)
      const expected = expectedDigests.get(entityType)
      if (expected === undefined) {
        throw new RebuildIntegrityError(
          `rebuildIndex: epoch ${epoch} carries projection segment ${filename} that is not declared in the manifest (CQ-046)`,
        )
      }
      const actual = `blake3:${toHex(blake3(rawBytes))}`
      if (actual !== expected) {
        throw new RebuildIntegrityError(
          `rebuildIndex: epoch ${epoch} segment ${filename} digest mismatch (declared ${expected}, actual ${actual})`,
        )
      }
      expectedDigests.delete(entityType)

      const keyspace = KEYSPACE_FOR_ENTITY[entityType]
      if (!keyspace) continue
      const pkField = ENTITY_PRIMARY_KEY[entityType]
      const raw = new TextDecoder().decode(rawBytes)
      const lines = raw.split('\n').filter((l) => l.length > 0)
      // First line is the header; skip it.
      for (let i = 1; i < lines.length; i++) {
        const row = JSON.parse(lines[i] as string) as Record<string, unknown>
        const key = row[pkField] as string | undefined
        if (typeof key !== 'string' || key.length === 0) continue
        recordEntry(keyspace, key, row)
      }
    }
    // CQ-046 step 2: every projection segment declared in the
    // manifest must exist on disk. A missing declared segment is a
    // hard error.
    if (expectedDigests.size > 0) {
      const missing = Array.from(expectedDigests.keys()).join(', ')
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${epoch} manifest declares projection segments that are not on disk: ${missing} (CQ-046)`,
      )
    }
  }

  // Write per-shard scratch logs.
  const perShardCounts: number[] = Array.from({ length: SHARD_COUNT }, () => 0)
  const enc = new TextEncoder()
  for (let shard = 0; shard < SHARD_COUNT; shard++) {
    const lines = shardLines.get(shard) ?? []
    const path = join(scratch, `shard-${String(shard).padStart(2, '0')}.log`)
    const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`
    // CQ-043: durable per-shard writes so a crash mid-rebuild can never
    // leave a half-written log under `tmp/index-rebuild-*`.
    await writeFileDurable(path, enc.encode(body))
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
  // CQ-043: the rebuild manifest is the "I am complete" marker; write
  // it last and durably so `reapStaleTmp` can use its presence as the
  // commit indicator.
  await writeFileDurable(join(scratch, 'rebuild.manifest'), enc.encode(`${JSON.stringify(manifest, null, 2)}\n`))
  await syncDir(scratch)

  // Atomic install: rename old index/ → index-old-<ts>/ (if any), then
  // rename scratch → index/. fsync the containing dir after every rename
  // so a crash before the next step does not lose the directory entry.
  let archivedAt: string | null = null
  const indexStat = await stat(bundle.paths.index).catch(() => null)
  if (indexStat?.isDirectory()) {
    const stamp = rebuiltAt.replace(/[:.]/g, '-')
    archivedAt = indexOldDir(bundle.paths.root, stamp)
    await rename(bundle.paths.index, archivedAt)
    await syncDir(dirname(archivedAt))
  }
  await rename(scratch, bundle.paths.index)
  await syncDir(dirname(bundle.paths.index))
  return { manifest, newIndexDir: bundle.paths.index, archivedAt }
}

/**
 * Read the signed manifest for one epoch, verify its body matches the
 * unsigned `epoch.manifest.json` (canonical byte equality), and — for
 * the current head epoch — verify the unsigned bytes match
 * `head.json`'s `manifestDigest`. Return a map of entityType →
 * declared digest for each projection segment.
 *
 * CQ-046: a tampered signed manifest with rewritten segment digests
 * would otherwise be trusted blindly. The dual-file cross-check + the
 * head.json pin close the obvious tampering paths until full Ed25519
 * signing lands.
 */
async function loadProjectionDigests(bundle: Bundle, epoch: number): Promise<Map<CanonicalEntityType, string>> {
  const out = new Map<CanonicalEntityType, string>()
  const epochRoot = join(bundle.paths.root, 'epochs', String(epoch))
  const signedPath = join(epochRoot, 'epoch.manifest.signed.json')
  const unsignedPath = join(epochRoot, 'epoch.manifest.json')

  let signedBytes: Uint8Array
  let unsignedBytes: Uint8Array
  try {
    signedBytes = await readFile(signedPath)
    unsignedBytes = await readFile(unsignedPath)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // CQ-046: a sealed epoch dir without a manifest is itself an
      // integrity failure — refuse to fall through to "skip digest
      // checks" silently.
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${epoch} has no manifest pair (${e.path ?? signedPath}) — refusing to trust segments`,
      )
    }
    throw err
  }

  // Verify the signed manifest's `manifest` body matches the unsigned
  // file byte-for-byte under canonical JSON encoding. Anything else
  // means one of the two files has drifted.
  const signed = JSON.parse(new TextDecoder().decode(signedBytes)) as {
    manifest?: unknown
    signature?: unknown
  }
  if (!signed.manifest || typeof signed.manifest !== 'object') {
    throw new RebuildIntegrityError(`rebuildIndex: epoch ${epoch} signed manifest is missing the manifest body`)
  }
  // Re-encode the signed manifest's body canonically and compare to
  // the unsigned bytes. `epochManifestBytes` is the same canonical
  // encoder used at seal time.
  const { epochManifestBytes } = await import('../epoch/manifest.js')
  const reEncoded = epochManifestBytes(signed.manifest as Parameters<typeof epochManifestBytes>[0])
  if (!bytesEqual(reEncoded, unsignedBytes)) {
    throw new RebuildIntegrityError(
      `rebuildIndex: epoch ${epoch} signed manifest body does not canonical-encode to epoch.manifest.json bytes`,
    )
  }

  // For the current head epoch, pin the unsigned bytes against
  // head.json's manifestDigest. Older epochs lack a stored
  // authoritative digest at this stage; the previousBundleRoot chain
  // is the longer-term anchor.
  //
  // CQ-050 (reviewer-F2): require `manifestDigest` to be a non-empty
  // tagged-hash string for the current head. A missing field
  // (undefined/null/'') is itself an integrity failure — an attacker
  // could otherwise strip it to silently disable the pin check.
  if (epoch === bundle.head.epoch) {
    const declared = bundle.head.manifestDigest
    if (typeof declared !== 'string' || declared.length === 0) {
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${epoch} is current head but head.json.manifestDigest is missing or empty`,
      )
    }
    const actual = `blake3:${toHex(blake3(unsignedBytes))}`
    if (actual !== declared) {
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${epoch} manifest blake3 ${actual} does not match head.json manifestDigest ${declared}`,
      )
    }
  }

  const parsed = signed as {
    manifest?: { segments?: Array<{ kind?: string; entityType?: string; digest?: string }> }
  }
  const segments = parsed.manifest?.segments ?? []
  for (const s of segments) {
    if ((s.kind === 'projection_arrow' || s.kind === 'projection_parquet') && s.entityType && s.digest) {
      out.set(s.entityType as CanonicalEntityType, s.digest)
    }
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
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
