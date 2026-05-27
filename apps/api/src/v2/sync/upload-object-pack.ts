// Lane 5 — UploadObjectPack handler.
//
// `POST /v2/promotions/:promotionId/object-packs` receives the binary
// CAS pack format from Lane 1 and:
//
// 1. Resolves the `promotion_staging` row by `(id, tenant_id)`. Miss
//    or terminal status → `404 PROMOTION_NOT_FOUND`.
// 2. Reads the buffered octet-stream body and computes two distinct
//    hashes:
//    - `transportHash` = BLAKE3 of the bytes literally received on
//      the wire (CQ-012). Compared to the optional
//      `x-prosa-transport-hash: blake3:<hex>` header when present.
//    - `packDigest` = the self-referential digest from the pack
//      header (`verifyCasPack(bytes).header.pack_digest`, CQ-026).
//      Compared to the optional `x-prosa-pack-digest: blake3:<hex>`
//      header when present.
//    The two values are intentionally different — `packDigest` is
//    BLAKE3 over the frame with the `pack_digest` field replaced by a
//    placeholder, so a CAS pack's content identity is stable even
//    though its on-disk bytes change every time the digest is
//    embedded.
// 3. Runs `verifyCasPack(bytes)` from `@c3-oss/prosa-bundle-v2` — the
//    canonical pack verifier checks the framing magic/version, the
//    canonical JSON encoding of the header, the self-referential
//    `pack_digest`, every entry's `stored_hash`, every entry's
//    `uncompressed_hash`, and the declared `zstd_window_log` against
//    the canonical cap.
// 4. Idempotency check: if `remote_pack WHERE tenant_id=$1 AND
//    pack_digest=$2` already exists, return `already_present`.
// 5. `putIfAbsent` into the object store at
//    `object-packs/<tenant>/<pack_digest>.pack`.
// 6. INSERT `remote_pack` + N `remote_pack_entry` rows in one
//    transaction. The primary keys `(tenant_id, pack_digest[, entry_index])`
//    keep this idempotent under concurrent retries — the second
//    inserter races and gets a `23505` unique_violation, which the
//    handler surfaces as `already_present`.

import { verifyCasPack } from '@c3-oss/prosa-bundle-v2'
import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { blake3 } from '@noble/hashes/blake3'
import type { DatabaseHandle, RawExec } from '../../db.js'

export type UploadObjectPackDeps = {
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  tenantId: string
  objectStore: RemoteObjectStore
}

export type UploadObjectPackParams = {
  promotionId: string
  /** Buffered pack bytes (raw octet-stream body). */
  body: Uint8Array
  /** Optional declared canonical `x-prosa-pack-digest: blake3:<hex>` header. */
  declaredPackDigest?: string
  /** Optional `x-prosa-transport-hash: blake3:<hex>` header. */
  transportHash?: string
  /** CQ-127: see UploadSegmentParams.requestingDeviceId. */
  requestingDeviceId?: string
}

export type UploadObjectPackResult =
  | { status: 'accepted'; packDigest: string; entryCount: number; storageKey: string }
  | { status: 'already_present'; packDigest: string; entryCount: number; storageKey: string }

export class UploadObjectPackNotFoundError extends Error {
  override name = 'UploadObjectPackNotFoundError'
  readonly code = 'PROMOTION_NOT_FOUND' as const
}

export class UploadObjectPackValidationError extends Error {
  override name = 'UploadObjectPackValidationError'
  constructor(
    message: string,
    readonly issues: Array<{ field: string; expected: string; received: string }>,
  ) {
    super(message)
  }
}

export class UploadObjectPackDeviceMismatchError extends Error {
  override name = 'UploadObjectPackDeviceMismatchError'
  readonly code = 'DEVICE_MISMATCH' as const
  constructor(
    readonly stagingDeviceId: string,
    readonly requestingDeviceId: string,
  ) {
    super(
      `promotion is owned by device ${stagingDeviceId}; ` + `requesting device ${requestingDeviceId} cannot act on it`,
    )
  }
}

// CQ-141: catalog says `(tenant, pack_digest)` is already known
// but the bytes at the canonical storage key disagree (wrong
// hash or length) with what the client is uploading right now.
// Fail closed without deleting the stored bytes — destructive
// repair from the request body is unsafe when `putIfAbsent` is
// the only write primitive (a failed replacement leaves bytes
// gone). An operator must reconcile catalog vs. storage out of
// band before the pack can be linked to a promotion.
export class UploadObjectPackBytesCorruptError extends Error {
  override name = 'UploadObjectPackBytesCorruptError'
  readonly code = 'PACK_BYTES_CORRUPT' as const
  constructor(
    readonly packDigest: string,
    readonly storageKey: string,
    readonly expectedHash: string,
    readonly expectedSize: number,
    readonly actualHash: string,
    readonly actualSize: number,
  ) {
    super(
      `pack ${packDigest} at ${storageKey}: stored bytes do not match ` +
        `(expected hash=${expectedHash} size=${expectedSize}, ` +
        `actual hash=${actualHash} size=${actualSize})`,
    )
  }
}

type StagingRow = { status: string; device_id: string }

// CQ-131: materializing is in-flight authority-swap territory —
// no new bytes accepted. Sealed/aborted likewise.
const CLOSED_STAGING_STATUSES = new Set(['sealed', 'aborted', 'materializing'])

export async function uploadObjectPack(
  deps: UploadObjectPackDeps,
  params: UploadObjectPackParams,
): Promise<UploadObjectPackResult> {
  const stagingRows = await deps.rawExec<StagingRow>(
    `SELECT status, device_id FROM promotion_staging WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [params.promotionId, deps.tenantId],
  )
  if (stagingRows.length === 0) {
    throw new UploadObjectPackNotFoundError(`promotion ${params.promotionId} not found`)
  }
  const stagingRow = stagingRows[0]!
  if (CLOSED_STAGING_STATUSES.has(stagingRow.status)) {
    throw new UploadObjectPackNotFoundError(
      `promotion ${params.promotionId} is ${stagingRow.status}; cannot accept new packs`,
    )
  }
  if (params.requestingDeviceId !== undefined && params.requestingDeviceId !== stagingRow.device_id) {
    throw new UploadObjectPackDeviceMismatchError(stagingRow.device_id, params.requestingDeviceId)
  }

  const observedTransportHash = `blake3:${toHex(blake3(params.body))}`
  const issues: Array<{ field: string; expected: string; received: string }> = []

  // CQ-130: `uploadObjectPackHeaderSchema` requires `transportHash`.
  // The server enforces it here so a client that omits the header
  // fails closed instead of relying on the catalog/canonical-digest
  // checks alone.
  if (params.transportHash === undefined) {
    throw new UploadObjectPackValidationError('x-prosa-transport-hash header is required', [
      { field: 'transportHash', expected: 'blake3:<64-hex>', received: '<missing>' },
    ])
  }
  if (params.transportHash !== observedTransportHash) {
    issues.push({ field: 'transportHash', expected: observedTransportHash, received: params.transportHash })
    throw new UploadObjectPackValidationError('declared transport hash disagrees with streamed BLAKE3', issues)
  }

  // CQ-012 / CQ-026 / Lane 4 verification: full pack format check.
  // Throws on any framing, header canonicalization, window-cap,
  // per-entry, or self-referential digest violation. The canonical
  // pack digest comes from the verified header.
  let verified: ReturnType<typeof verifyCasPack>
  try {
    verified = verifyCasPack(params.body)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UploadObjectPackValidationError('pack failed CAS verification', [
      { field: 'pack', expected: 'verifyCasPack(bytes) success', received: message },
    ])
  }
  const observedDigest = verified.header.pack_digest

  if (params.declaredPackDigest !== undefined && params.declaredPackDigest !== observedDigest) {
    throw new UploadObjectPackValidationError('declared pack digest disagrees with verified pack header', [
      { field: 'packDigest', expected: observedDigest, received: params.declaredPackDigest },
    ])
  }

  // Idempotency fast path: same (tenant, pack_digest) already
  // catalogued. Still link the pack to this promotion so
  // SealPromotion can grant it (the catalog is tenant-wide and
  // may pre-exist from a prior promotion).
  const existingRows = await deps.rawExec<{ entry_count: number; storage_uri: string; byte_hash: string | null }>(
    `SELECT entry_count, storage_uri, byte_hash FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2 LIMIT 1`,
    [deps.tenantId, observedDigest],
  )
  if (existingRows.length > 0) {
    // CQ-141: the catalog says `(tenant, pack_digest)` is already
    // known, but the object-store side can be in three states:
    //   1. healthy — head() returns metadata that matches the
    //      uploaded bytes (correct hash AND length);
    //   2. missing — head() returns null;
    //   3. wrong-content — head() returns metadata whose hash or
    //      length does NOT match the canonical bytes.
    //
    // (1) accept verbatim. (2) repair via `putIfAbsent` (safe:
    // no existing bytes to lose, and the put is per-key
    // atomic). (3) FAIL CLOSED: the only write primitive is
    // `putIfAbsent`, so any in-place replacement would have to
    // `delete()` first — and a `putIfAbsent` failure after
    // delete strands the catalog row pointing at empty storage.
    // Reviewer 2026-05-20 rejected the destructive repair; an
    // operator must heal the storage/catalog drift out of band.
    const storageKey = existingRows[0]!.storage_uri
    const expectedHash = observedTransportHash.slice('blake3:'.length).toLowerCase()
    const expectedSize = params.body.byteLength
    const head = await deps.objectStore.head(storageKey)
    if (head === null) {
      // Missing-bytes repair: safe because nothing is deleted.
      await deps.objectStore.putIfAbsent(storageKey, asyncOnce(params.body), {
        hash: expectedHash,
        hashAlgorithm: 'blake3',
        uncompressedSize: expectedSize,
        compressedSize: expectedSize,
      })
    } else {
      const headHash = head.hash.toLowerCase()
      const matches = headHash === expectedHash && head.compressedSize === expectedSize
      if (!matches) {
        throw new UploadObjectPackBytesCorruptError(
          observedDigest,
          storageKey,
          expectedHash,
          expectedSize,
          headHash,
          head.compressedSize,
        )
      }
    }
    // Backfill byte_hash for catalog rows that pre-date this
    // column (rows inserted before the CQ-141 closure had
    // byte_hash=null). After the matches-check passes, the
    // expected hash is authoritative for this pack_digest.
    if (existingRows[0]!.byte_hash === null) {
      await deps.rawExec(
        `UPDATE remote_pack SET byte_hash = $3
          WHERE tenant_id = $1 AND pack_digest = $2 AND byte_hash IS NULL`,
        [deps.tenantId, observedDigest, expectedHash],
      )
    }
    await linkPackToPromotion(deps, params.promotionId, observedDigest)
    return {
      status: 'already_present',
      packDigest: observedDigest,
      entryCount: Number(existingRows[0]!.entry_count),
      storageKey,
    }
  }

  const storageKey = objectPackStorageKey(deps.tenantId, observedDigest)
  // The object store verifies `meta.hash` against the literal bytes
  // written. CAS packs have a self-referential `packDigest` that
  // differs from the wire BLAKE3 (CQ-026: the digest is computed
  // over the frame with the `pack_digest` field zeroed), so we hand
  // the store the literal transport hash instead.
  const putResult = await deps.objectStore.putIfAbsent(storageKey, asyncOnce(params.body), {
    hash: observedTransportHash.slice('blake3:'.length),
    hashAlgorithm: 'blake3',
    uncompressedSize: params.body.byteLength,
    compressedSize: params.body.byteLength,
  })
  // CQ-132: if THIS request wrote new bytes (not an
  // already-present hit), we own them until the catalog INSERT
  // commits. Any non-23505 failure below must best-effort delete
  // the storage key so the byte stream does not orphan. Pre-existing
  // bytes from a prior successful upload or a concurrent idempotent
  // retry are left intact (those are not ours to delete).
  const newlyWritten = !putResult.alreadyExisted

  // INSERT catalog rows atomically. Primary keys
  // `(tenant_id, pack_digest)` and `(tenant_id, pack_digest, entry_index)`
  // make the operation idempotent under racing duplicates: the
  // second inserter raises `unique_violation` and we treat it as
  // already_present.
  try {
    await deps.transaction(async (tx) => {
      await tx(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', $3, $4, $5, $6, $7, $8)`,
        [
          deps.tenantId,
          observedDigest,
          verified.header.entry_count,
          params.body.byteLength,
          // CQ-141: persist the canonical transport (wire-byte)
          // BLAKE3 alongside `byte_length` so SealPromotion can
          // compare object-store head() against durable expected
          // metadata before authority grant.
          observedTransportHash
            .slice('blake3:'.length)
            .toLowerCase(),
          deriveObjectSetRoot(verified.entries.map((e) => e.entry.object_id)),
          verified.header.standalone_large_object,
          storageKey,
        ],
      )
      for (let i = 0; i < verified.entries.length; i++) {
        const e = verified.entries[i]!.entry
        await tx(
          `INSERT INTO remote_pack_entry (
             tenant_id, pack_digest, entry_index, object_id,
             uncompressed_size, stored_offset, stored_length,
             stored_hash, compression
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            deps.tenantId,
            observedDigest,
            i,
            e.object_id,
            e.uncompressed_size,
            e.stored_offset,
            e.stored_length,
            e.stored_hash,
            e.compression,
          ],
        )
      }
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      const rows = await deps.rawExec<{ entry_count: number; storage_uri: string }>(
        `SELECT entry_count, storage_uri FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2 LIMIT 1`,
        [deps.tenantId, observedDigest],
      )
      const row = rows[0]
      if (row) {
        await linkPackToPromotion(deps, params.promotionId, observedDigest)
        return {
          status: 'already_present',
          packDigest: observedDigest,
          entryCount: Number(row.entry_count),
          storageKey: row.storage_uri,
        }
      }
    }
    // CQ-132: non-idempotent catalog failure. If THIS request
    // wrote the bytes, best-effort delete the storage key so it
    // does not orphan. Before deleting we re-check the catalog:
    // a concurrent request B may have raced past our putIfAbsent
    // (observing our newly-written bytes as `alreadyExisted`)
    // and committed its catalog rows while our transaction
    // failed. Deleting in that interleaving would orphan B's
    // remote_pack/remote_pack_entry rows. The re-check holds the
    // invariant: bytes are only deleted when no catalog row
    // references them.
    if (newlyWritten) {
      const aliveRows = await deps.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`,
        [deps.tenantId, observedDigest],
      )
      const referenced = Number(aliveRows[0]?.count ?? 0) > 0
      if (!referenced) {
        try {
          await deps.objectStore.delete(storageKey)
        } catch {
          // Swallow — the catalog failure is the load-bearing
          // error we want to surface. Cleanup is best-effort and
          // a follow-up audit/GC pass will reap any survivor.
        }
      }
    }
    throw err
  }

  await linkPackToPromotion(deps, params.promotionId, observedDigest)
  await deps.rawExec(`UPDATE promotion_staging SET updated_at = now() WHERE id = $1 AND tenant_id = $2`, [
    params.promotionId,
    deps.tenantId,
  ])

  return {
    status: 'accepted',
    packDigest: observedDigest,
    entryCount: verified.header.entry_count,
    storageKey,
  }
}

async function linkPackToPromotion(deps: UploadObjectPackDeps, promotionId: string, packDigest: string): Promise<void> {
  await deps.rawExec(
    `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest)
     VALUES ($1, $2, $3)
     ON CONFLICT (promotion_id, pack_digest) DO NOTHING`,
    [promotionId, deps.tenantId, packDigest],
  )
}

export function objectPackStorageKey(tenantId: string, packDigest: string): string {
  const hex = packDigest.startsWith('blake3:') ? packDigest.slice('blake3:'.length) : packDigest
  return `object-packs/${tenantId}/${hex}.pack`
}

// Best-effort object-set root for the schema column. The canonical
// Merkle root is computed by the client over the sorted object_ids;
// the server re-derives a deterministic hash for the column so the
// row is queryable. The seal slice will verify against the
// client-declared root when it materializes the inventory.
function deriveObjectSetRoot(objectIds: readonly string[]): string {
  const sorted = [...objectIds].sort()
  const joined = new TextEncoder().encode(sorted.join('\n'))
  return toHex(blake3(joined))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === '23505'
}
