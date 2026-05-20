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

import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import type { BundleHeadV2Wire, SegmentRefWire } from '@c3-oss/prosa-wire-v2'

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

  if (begin.status === 'already_promoted') {
    return { status: 'already_promoted', receipt: begin.receipt }
  }
  const promotionId = begin.promotionId

  // 2. Upload inventories. The server-side `needs_inventory` placeholder
  //    keeps both refs in the missing list; we upload both whether or
  //    not the server later flips to `needs_upload`.
  await uploadSegment(client, {
    promotionId,
    segmentId: input.objectInventory.ref.segmentId,
    bytes: input.objectInventory.bytes,
    digest: input.objectInventory.ref.digest,
  })
  await uploadSegment(client, {
    promotionId,
    segmentId: input.projectionInventory.ref.segmentId,
    bytes: input.projectionInventory.bytes,
    digest: input.projectionInventory.ref.digest,
  })

  // 3. Upload object packs.
  for (const pack of input.objectPacks) {
    const response = await client({
      method: 'POST',
      url: `/v2/promotions/${promotionId}/object-packs`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-prosa-transport-hash': `blake3:${await blake3Hex(pack.bytes)}`,
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
    headers: { 'content-type': 'application/json' },
    body: {},
  })
  if (sealResponse.statusCode !== 200) {
    throw new PromoteV2Error('SealPromotion failed', 'seal', sealResponse.statusCode, sealResponse.json())
  }
  const seal = sealResponse.json() as { status: 'sealed'; receipt: PromotionReceiptV2 }
  return { status: 'sealed', receipt: seal.receipt, promotionId }
}

async function uploadSegment(
  client: PromoteHttpClient,
  opts: { promotionId: string; segmentId: string; bytes: Uint8Array; digest: string },
): Promise<void> {
  const response = await client({
    method: 'PUT',
    url: `/v2/promotions/${opts.promotionId}/segments/${opts.segmentId}`,
    headers: {
      'content-type': 'application/octet-stream',
      'x-prosa-transport-hash': opts.digest,
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
