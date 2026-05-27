// EpochManifestV2 — the per-epoch manifest that lives in
// `epochs/<n>/epoch.manifest.cbor`. In Lane 1 we keep it as canonical JSON
// for the same reasoning as the pack headers; the CBOR transport is
// reserved for the wire protocol where `prosa-wire-v2` will encode it
// before signing.
//
// The manifest is signed with a per-bundle Ed25519 key generated at
// `initBundle` (deferred to a later Lane 1 iteration — for now we emit an
// empty placeholder signature).

import type { BundleCountsV2, SegmentRef } from '@c3-oss/prosa-types-v2'

export type EpochManifestV2 = {
  bundleFormat: 2
  storeId: string
  epoch: number
  parserVersion: string
  createdAt: string
  previousEpoch: number | null
  previousBundleRoot: string | null

  bundleRoot: string
  rawSourceRoot: string

  segments: SegmentRef[]
  counts: BundleCountsV2
}

export type EpochManifestSignatureV2 = {
  alg: 'Ed25519' | 'none'
  keyId: string
  sig: string // base64url; empty when alg='none' (placeholder for Lane 1 partial)
}

export type SignedEpochManifestV2 = {
  manifest: EpochManifestV2
  signature: EpochManifestSignatureV2
}

export const PLACEHOLDER_SIGNATURE: EpochManifestSignatureV2 = {
  alg: 'none',
  keyId: 'bundle-key-deferred',
  sig: '',
}

/**
 * Build the canonical JSON byte string that the bundle key signs. The
 * signature is computed over this byte string. When the Ed25519 wiring
 * lands in a follow-up iteration, this is exactly the input fed to the
 * signer.
 */
export function epochManifestBytes(manifest: EpochManifestV2): Uint8Array {
  // Canonical JSON: sorted keys, no whitespace. We reuse the pack
  // framing helper rather than re-implement.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- circular import guard
  const enc = new TextEncoder()
  return enc.encode(canonicalJsonOf(manifest))
}

function canonicalJsonOf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonOf(v)).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonOf(obj[k])}`).join(',')}}`
  }
  throw new Error(`canonicalJsonOf: unsupported ${typeof value}`)
}
