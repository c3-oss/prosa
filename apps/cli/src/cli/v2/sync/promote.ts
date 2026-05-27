// Lane 5 CLI — v2 promotion client.
//
// Drives the four-call promotion protocol against a v2-capable
// prosa-api server: BeginPromotion → upload inventory segments →
// upload object packs → SealPromotion. Designed to be testable
// in-process via Fastify's `inject(...)` and to run against a real
// HTTP endpoint via `fetch`. Both targets implement the
// `PromoteHttpClient` interface below.
//
// This slice does NOT yet implement:
// - resume-after-interrupt checkpoints (slice 8),
// - adaptive upload concurrency (slice 9),
// - rich progress reporting / dry-run / --json flags (slice 9).
//
// The client returns either `already_promoted` (no-op fast path) or
// `sealed` (full promotion). Callers can then persist the receipt
// locally and update their authority cache.

import { type PromotionReceiptV2, deriveReceiptId, receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { type BundleHeadV2Wire, type SegmentRefWire, promotionReceiptV2Schema } from '@c3-oss/prosa-wire-v2'

export type PromoteHttpRequest = {
  method: 'GET' | 'POST' | 'PUT'
  url: string
  headers: Record<string, string>
  body?: Uint8Array | object
}

export type PromoteHttpResponse = {
  statusCode: number
  json(): unknown
}

export type PromoteHttpClient = (req: PromoteHttpRequest) => Promise<PromoteHttpResponse>

export type PromoteInput = {
  tenantId: string
  storeId: string
  storePath: string
  deviceId: string
  head: BundleHeadV2Wire
  objectInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  projectionInventory: { ref: SegmentRefWire; bytes: Uint8Array }
  objectPacks: Array<{ bytes: Uint8Array }>
  /**
   * G7 cutover: every projection_arrow NDJSON segment to upload
   * before sealing. The server materializes them into
   * `projection_<entity>` rows during seal; without them
   * `read --authority remote` would surface zero rows for every
   * entity.
   */
  projectionSegments?: Array<{ ref: SegmentRefWire; bytes: Uint8Array }>
  /**
   * When true, skip the server-side resume optimisation
   * (status fetch + uploaded-pack-digest short-circuit) and
   * re-upload every inventory + pack. Wired from CLI
   * `--no-resume`. Defaults to false: resume is on.
   */
  skipResume?: boolean
}

export type PromoteResult =
  | { status: 'already_promoted'; receipt: PromotionReceiptV2 }
  | { status: 'sealed'; receipt: PromotionReceiptV2; promotionId: string }

export class PromoteV2Error extends Error {
  override name = 'PromoteV2Error'
  constructor(
    message: string,
    readonly step: string,
    readonly statusCode: number,
    readonly response: unknown,
  ) {
    super(`${step}: ${message} (HTTP ${statusCode})`)
  }
}

export async function promoteBundleV2(client: PromoteHttpClient, input: PromoteInput): Promise<PromoteResult> {
  // 1. BeginPromotion.
  const beginBody = {
    protocolVersion: 2,
    tenantId: input.tenantId,
    storeId: input.storeId,
    storePath: input.storePath,
    head: input.head,
    inventories: {
      objectInventorySegment: input.objectInventory.ref,
      projectionInventorySegment: input.projectionInventory.ref,
    },
    device: { deviceId: input.deviceId },
  }
  const beginResponse = await client({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json' },
    body: beginBody,
  })
  if (beginResponse.statusCode !== 200) {
    throw new PromoteV2Error('BeginPromotion failed', 'begin', beginResponse.statusCode, beginResponse.json())
  }
  const begin = beginResponse.json() as
    | { status: 'already_promoted'; receipt: PromotionReceiptV2 }
    | { status: 'needs_inventory'; promotionId: string; missingInventories: SegmentRefWire[] }
    | { status: 'needs_upload'; promotionId: string }

  // CQ-138: every receipt the CLI surfaces to the user — whether
  // from BeginPromotion's `already_promoted` fast path or
  // SealPromotion's freshly minted receipt — must pass canonical
  // schema validation AND content-addressed derived-id check AND
  // JWKS signature verification. We fetch the keys lazily on the
  // first receipt and reuse them for any subsequent verification
  // in the same call.
  const verifier = createReceiptVerifier(client)

  if (begin.status === 'already_promoted') {
    await verifier.verifyOrThrow(begin.receipt, 'begin')
    return { status: 'already_promoted', receipt: begin.receipt }
  }
  const promotionId = begin.promotionId

  // 2. Resume optimisation: ask the server which inventory segments
  //    and pack digests are already present so we don't re-upload
  //    bytes after an interrupt. Uploads are idempotent server-side
  //    even without this query, so a status fetch failure is not
  //    fatal — the client falls back to uploading every byte.
  //
  //    CQ-127: every post-begin request carries the device id so
  //    the server's mandatory device check passes.
  //
  //    --no-resume (Lane 5 gate L5.6): when set, treat the server
  //    as if no inventory/pack is uploaded yet and re-send every
  //    byte. Uploads remain idempotent server-side; the override
  //    only affects which calls the client makes.
  const remoteState = input.skipResume === true ? null : await tryFetchStatus(client, promotionId, input.deviceId)

  // 3. Upload inventories.
  if (!remoteState?.inventories.object.uploaded) {
    await uploadSegment(client, {
      promotionId,
      segmentId: input.objectInventory.ref.segmentId,
      bytes: input.objectInventory.bytes,
      digest: input.objectInventory.ref.digest,
      deviceId: input.deviceId,
    })
  }
  if (!remoteState?.inventories.projection.uploaded) {
    await uploadSegment(client, {
      promotionId,
      segmentId: input.projectionInventory.ref.segmentId,
      bytes: input.projectionInventory.bytes,
      digest: input.projectionInventory.ref.digest,
      deviceId: input.deviceId,
    })
  }
  // G7 cutover: upload every projection_arrow NDJSON segment.
  // The server's upload-segment handler accepts them because
  // `head_json.segments[]` (already persisted on BeginPromotion)
  // declares each one. Uploads are idempotent server-side, so a
  // resume after an interrupt re-sends the same bytes without
  // tracking per-segment state.
  for (const segment of input.projectionSegments ?? []) {
    await uploadSegment(client, {
      promotionId,
      segmentId: segment.ref.segmentId,
      bytes: segment.bytes,
      digest: segment.ref.digest,
      deviceId: input.deviceId,
    })
  }

  // 4. Upload object packs. Hash each pack first so we can ask the
  //    server whether it already has this digest before sending bytes.
  const remoteDigests = new Set(remoteState?.uploadedPackDigests ?? [])
  for (const pack of input.objectPacks) {
    const transportHash = `blake3:${await blake3Hex(pack.bytes)}`
    if (remoteDigests.has(transportHash)) {
      // remote_pack indexes by self-referential pack_digest, which for
      // CAS packs is NOT the wire BLAKE3 — so this short-circuit only
      // skips when the server already saw the literal bytes (which
      // means it also has the pack catalogued). Otherwise we POST and
      // the server returns `already_present` if the catalogued digest
      // matches.
      continue
    }
    const response = await client({
      method: 'POST',
      url: `/v2/promotions/${promotionId}/object-packs`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-prosa-transport-hash': transportHash,
        'x-prosa-device-id': input.deviceId,
      },
      body: pack.bytes,
    })
    if (response.statusCode !== 200) {
      throw new PromoteV2Error('UploadObjectPack failed', 'upload-pack', response.statusCode, response.json())
    }
  }

  // 4. SealPromotion.
  const sealResponse = await client({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/seal`,
    headers: {
      'content-type': 'application/json',
      'x-prosa-device-id': input.deviceId,
    },
    body: {},
  })
  if (sealResponse.statusCode !== 200) {
    throw new PromoteV2Error('SealPromotion failed', 'seal', sealResponse.statusCode, sealResponse.json())
  }
  const seal = sealResponse.json() as { status: 'sealed'; receipt: PromotionReceiptV2 }
  await verifier.verifyOrThrow(seal.receipt, 'seal')
  return { status: 'sealed', receipt: seal.receipt, promotionId }
}

type ReceiptKey = { kty: string; crv: string; kid: string; x: string }

function createReceiptVerifier(client: PromoteHttpClient): {
  verifyOrThrow: (receipt: PromotionReceiptV2, step: string) => Promise<void>
} {
  let cachedKeys: ReceiptKey[] | null = null
  const fetchKeys = async (): Promise<ReceiptKey[]> => {
    if (cachedKeys !== null) return cachedKeys
    const response = await client({
      method: 'GET',
      url: '/v2/.well-known/receipt-keys.json',
      headers: {},
    })
    if (response.statusCode !== 200) {
      throw new PromoteV2Error(
        'failed to fetch receipt JWKS for signature verification',
        'jwks',
        response.statusCode,
        response.json(),
      )
    }
    const body = response.json() as { keys?: ReceiptKey[] }
    if (!body.keys || !Array.isArray(body.keys)) {
      throw new PromoteV2Error('JWKS response has no `keys` array', 'jwks', response.statusCode, body)
    }
    cachedKeys = body.keys
    return cachedKeys
  }

  return {
    async verifyOrThrow(receipt, step) {
      // Schema: the wire shape must parse against the canonical
      // v2 receipt schema (incl. opaqueAuthIdSchema for tenant /
      // store / device). Rejects malformed payloads, missing
      // counts, wrong materialization shape, etc.
      const parsed = promotionReceiptV2Schema.safeParse(receipt)
      if (!parsed.success) {
        throw new PromoteV2Error(
          `server returned a receipt that fails promotionReceiptV2Schema: ${parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
          step,
          200,
          receipt,
        )
      }
      // Content integrity: the canonical hash of the payload
      // bytes must match the signed receipt id. A same-tenant
      // attacker who mutated a non-tuple field after sealing
      // breaks this.
      const derived = deriveReceiptId(receipt.payload)
      if (derived !== receipt.payload.receiptId) {
        throw new PromoteV2Error(
          `receipt payload no longer hashes to its receipt id (got ${derived}, expected ${receipt.payload.receiptId})`,
          step,
          200,
          receipt,
        )
      }
      // Cryptographic verification against the server's JWKS.
      const keys = await fetchKeys()
      const key = keys.find((k) => k.kid === receipt.signature.keyId)
      if (!key) {
        throw new PromoteV2Error(
          `signature keyId ${receipt.signature.keyId} is not published in the server JWKS`,
          step,
          200,
          receipt,
        )
      }
      const { createPublicKey, verify } = await import('node:crypto')
      const publicKey = createPublicKey({ key: { ...key, alg: 'EdDSA' } as never, format: 'jwk' })
      const sigBytes = Buffer.from(receipt.signature.sig, 'base64url')
      const ok = verify(null, receiptPayloadBytes(receipt.payload), publicKey, sigBytes)
      if (!ok) {
        throw new PromoteV2Error('receipt signature does not verify against the server JWKS', step, 200, receipt)
      }
    },
  }
}

type RemotePromotionStatus = {
  status: string
  inventories: {
    object: { segmentId: string | null; uploaded: boolean }
    projection: { segmentId: string | null; uploaded: boolean }
  }
  uploadedPackDigests: string[]
}

async function tryFetchStatus(
  client: PromoteHttpClient,
  promotionId: string,
  deviceId: string,
): Promise<RemotePromotionStatus | null> {
  const response = await client({
    method: 'GET',
    url: `/v2/promotions/${promotionId}/status`,
    headers: { 'x-prosa-device-id': deviceId },
  })
  if (response.statusCode !== 200) return null
  return response.json() as RemotePromotionStatus
}

async function uploadSegment(
  client: PromoteHttpClient,
  opts: { promotionId: string; segmentId: string; bytes: Uint8Array; digest: string; deviceId: string },
): Promise<void> {
  const response = await client({
    method: 'PUT',
    url: `/v2/promotions/${opts.promotionId}/segments/${opts.segmentId}`,
    headers: {
      'content-type': 'application/octet-stream',
      'x-prosa-transport-hash': opts.digest,
      'x-prosa-device-id': opts.deviceId,
    },
    body: opts.bytes,
  })
  if (response.statusCode !== 200) {
    throw new PromoteV2Error(
      `UploadSegment ${opts.segmentId} failed`,
      'upload-segment',
      response.statusCode,
      response.json(),
    )
  }
}

async function blake3Hex(bytes: Uint8Array): Promise<string> {
  // Dynamic import keeps the cost off the cold path; the CLI doesn't
  // already depend on @noble/hashes/blake3 at the top level, and the
  // pack upload route already verifies the declared transport hash
  // against the streamed BLAKE3, so the cost here is just per-call
  // hashing of a buffer the test fixture also has the bytes for.
  const { blake3 } = await import('@noble/hashes/blake3')
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}
