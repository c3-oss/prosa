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
  /**
   * Internal fault-injection hook for `node:fs/promises` `rename`.
   * Tests use this to exercise the CQ-061 archive-rollback path
   * without monkey-patching ES module exports.
   */
  _renameImpl?: (from: string, to: string) => Promise<void>
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
 * Thrown when the scratch→`index/` rename fails after the old index was
 * already archived. Carries the archive location (when rollback failed)
 * so callers can restore service manually. CQ-061.
 */
export class RebuildInstallError extends Error {
  override name = 'RebuildInstallError'
  readonly archivedAt: string | null
  readonly rolledBack: boolean
  constructor(message: string, info: { archivedAt: string | null; rolledBack: boolean; cause: Error }) {
    super(message, { cause: info.cause })
    this.archivedAt = info.archivedAt
    this.rolledBack = info.rolledBack
  }
}

/**
 * Reconstruct the per-shard append-log index from sealed epoch
 * projection segments. The resulting `index/` contains
 * `shard-NN.log` files compatible with `MemoryShardActor.openPersistent`.
 */
export async function rebuildIndex(bundle: Bundle, options: RebuildIndexOptions = {}): Promise<RebuildIndexResult> {
  const uuid = options.uuid ?? base32LowerNoPad(randomBytes(8))
  const scratch = indexRebuildDir(bundle.paths.root, uuid)
  const renameImpl = options._renameImpl ?? rename
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

  // CQ-053 + CQ-056: head.json is authoritative for the epoch set.
  // The on-disk `epochs/` directory must equal exactly the contiguous
  // range `[1..head.epoch]`. Any stray epoch directory > head.epoch is
  // refused (stray content with no head authority). Any missing
  // epoch <= head.epoch is refused (silent gap that would otherwise
  // install an index missing prior epoch data). Empty bundles
  // (head.epoch === 0) require zero epoch directories.
  const expectedEpochs = new Set<number>()
  for (let n = 1; n <= bundle.head.epoch; n++) expectedEpochs.add(n)
  const onDiskEpochs = new Set(epochs)
  const stray: number[] = []
  for (const n of onDiskEpochs) {
    if (!expectedEpochs.has(n)) stray.push(n)
  }
  if (stray.length > 0) {
    throw new RebuildIntegrityError(
      `rebuildIndex: head.json declares epoch ${bundle.head.epoch} but epochs/ contains stray directories not under head authority: ${stray.sort((a, b) => a - b).join(', ')} (CQ-056)`,
    )
  }
  const missing: number[] = []
  for (const n of expectedEpochs) {
    if (!onDiskEpochs.has(n)) missing.push(n)
  }
  if (missing.length > 0) {
    throw new RebuildIntegrityError(
      `rebuildIndex: head.json declares epoch ${bundle.head.epoch} but the contiguous epoch range is missing: ${missing.sort((a, b) => a - b).join(', ')} (CQ-053 / CQ-056)`,
    )
  }

  // CQ-060: anchor every non-head epoch to current head authority via
  // the `previousBundleRoot` chain. head.json.manifestDigest pins the
  // current head's unsigned manifest body; that body declares both the
  // head's `bundleRoot` and its `previousBundleRoot`. Walking the chain
  // backward gives us the expected `bundleRoot` for every prior epoch,
  // rejecting lockstep tampering of an older epoch's projection + both
  // manifest files.
  const expectedBundleRootByEpoch = await buildEpochAuthorityChain(bundle)

  for (const epoch of epochs) {
    // CQ-043 + CQ-060: load the epoch manifest, verify the digest pin
    // (head.json for the current head epoch, the `previousBundleRoot`
    // chain for prior epochs), and return the manifest's segment
    // digest map. A drifted projection file or a tampered older epoch
    // would otherwise corrupt the rebuilt index silently.
    const expectedBundleRoot = expectedBundleRootByEpoch.get(epoch)
    const expectedDigests = await loadProjectionDigests(bundle, epoch, expectedBundleRoot)
    const projDir = join(bundle.paths.root, 'epochs', String(epoch), 'projection')
    let segments: string[]
    try {
      segments = await readdir(projDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // CQ-053: if the manifest declares projection segments but the
        // projection/ dir is missing, fail closed. A manifest with zero
        // projection segments (CAS-only epoch) is still allowed.
        if (expectedDigests.size > 0) {
          const missing = Array.from(expectedDigests.keys()).join(', ')
          throw new RebuildIntegrityError(
            `rebuildIndex: epoch ${epoch} manifest declares projection segments [${missing}] but epochs/${epoch}/projection/ is missing (CQ-053)`,
          )
        }
        continue
      }
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
  //
  // CQ-061: if the scratch→index rename fails after the old index was
  // archived, attempt to roll the archive back to `index/`. If the
  // rollback itself fails, surface a `RebuildInstallError` that carries
  // the archive path so the caller can recover manually instead of
  // silently losing the active index.
  let archivedAt: string | null = null
  const indexStat = await stat(bundle.paths.index).catch(() => null)
  if (indexStat?.isDirectory()) {
    const stamp = rebuiltAt.replace(/[:.]/g, '-')
    archivedAt = indexOldDir(bundle.paths.root, stamp)
    await renameImpl(bundle.paths.index, archivedAt)
    await syncDir(dirname(archivedAt))
  }
  try {
    await renameImpl(scratch, bundle.paths.index)
  } catch (installErr) {
    if (archivedAt) {
      try {
        // The rollback intentionally bypasses the injected impl —
        // a fault-injection test that breaks the install rename should
        // not also break recovery.
        await rename(archivedAt, bundle.paths.index)
        await syncDir(dirname(bundle.paths.index))
        throw new RebuildInstallError(
          `rebuildIndex: install rename failed; rolled archive back to ${bundle.paths.index} (CQ-061): ${(installErr as Error).message}`,
          { archivedAt: null, rolledBack: true, cause: installErr as Error },
        )
      } catch (rollbackErr) {
        if (rollbackErr instanceof RebuildInstallError) throw rollbackErr
        throw new RebuildInstallError(
          `rebuildIndex: install rename failed AND archive rollback failed; active index is at ${archivedAt} (CQ-061): install=${(installErr as Error).message}; rollback=${(rollbackErr as Error).message}`,
          { archivedAt, rolledBack: false, cause: installErr as Error },
        )
      }
    }
    throw installErr
  }
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
/**
 * CQ-060: walk the previousBundleRoot chain from current head back to
 * epoch 1 and return the expected `bundleRoot` for each epoch on disk.
 * Head's manifest body is already pinned by head.json.manifestDigest;
 * older epochs anchor to head transitively via the chain.
 *
 * Each epoch N's manifest carries `previousBundleRoot` which, when
 * non-null, must equal epoch (N-1)'s `bundleRoot`. We read head's
 * manifest first (pinned), record its `bundleRoot`, then walk backward
 * recording each previousBundleRoot as the expected `bundleRoot` of
 * the next-older epoch.
 */
async function buildEpochAuthorityChain(bundle: Bundle): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (bundle.head.epoch === 0) return out

  // head.json.bundleRoot is the canonical pin for the current head.
  const headBundleRoot = bundle.head.bundleRoot
  if (typeof headBundleRoot !== 'string' || headBundleRoot.length === 0) {
    throw new RebuildIntegrityError(
      'rebuildIndex: head.json.bundleRoot is missing or empty — cannot anchor non-head epochs (CQ-060)',
    )
  }
  out.set(bundle.head.epoch, headBundleRoot)

  // Walk backward by reading each manifest's previousBundleRoot.
  let expectedAtNext: string = headBundleRoot
  for (let n = bundle.head.epoch; n >= 2; n--) {
    const epochRoot = join(bundle.paths.root, 'epochs', String(n))
    const unsignedPath = join(epochRoot, 'epoch.manifest.json')
    let bytes: Uint8Array
    try {
      bytes = await readFile(unsignedPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RebuildIntegrityError(
          `rebuildIndex: epoch ${n} has no manifest pair; cannot build authority chain (CQ-060 / CQ-046)`,
        )
      }
      throw err
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      bundleRoot?: unknown
      previousBundleRoot?: unknown
    }
    // Confirm this epoch's own `bundleRoot` matches what the chain
    // expects (set by the prior iteration / head pin).
    if (parsed.bundleRoot !== expectedAtNext) {
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${n} manifest.bundleRoot does not match expected chain anchor (manifest=${String(parsed.bundleRoot)}, expected=${expectedAtNext}) (CQ-060)`,
      )
    }
    // Move the anchor down to epoch n-1.
    const prev = parsed.previousBundleRoot
    if (n === 1) break
    if (typeof prev !== 'string' || prev.length === 0) {
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${n} manifest.previousBundleRoot is missing — chain breaks before epoch 1 (CQ-060)`,
      )
    }
    out.set(n - 1, prev)
    expectedAtNext = prev
  }
  return out
}

async function loadProjectionDigests(
  bundle: Bundle,
  epoch: number,
  expectedBundleRoot: string | undefined,
): Promise<Map<CanonicalEntityType, string>> {
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

  // CQ-060: every walked epoch must match the bundleRoot anchor
  // derived from head.json (current head) or the previousBundleRoot
  // chain (older epochs). The chain was already cross-checked in
  // `buildEpochAuthorityChain`; here we additionally pin the
  // signed-manifest body's own `bundleRoot` field to the expected
  // anchor so a tamper that changes both manifest files in lockstep
  // is rejected when the chain expects a different anchor.
  if (expectedBundleRoot !== undefined) {
    const manifestBundleRoot = (signed.manifest as { bundleRoot?: unknown }).bundleRoot
    if (manifestBundleRoot !== expectedBundleRoot) {
      throw new RebuildIntegrityError(
        `rebuildIndex: epoch ${epoch} manifest.bundleRoot does not match head-authority chain (manifest=${String(manifestBundleRoot)}, expected=${expectedBundleRoot}) (CQ-060)`,
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
