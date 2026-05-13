import { createHash } from 'node:crypto'
import { blake3 } from '@noble/hashes/blake3'
import { bytesToHex } from '@noble/hashes/utils'

/**
 * Hash bytes with BLAKE3 and return lowercase hex.
 */
export function blake3Hex(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes))
}

/**
 * Hash bytes or text with SHA-256 and return lowercase hex.
 */
export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** "blake3:<hex>" — the canonical object_id format in the schema. */
export function objectIdFromHash(hashHex: string): string {
  return `blake3:${hashHex}`
}

/**
 * Storage path under `objects/blake3/`: `ab/cd/<hash>.zst` to avoid one giant
 * directory. Uses the first 4 hex chars (2-level fanout).
 */
export function objectStoragePath(hashHex: string, compression: 'zstd' | 'none'): string {
  const ext = compression === 'zstd' ? '.zst' : '.bin'
  const a = hashHex.slice(0, 2)
  const b = hashHex.slice(2, 4)
  return `objects/blake3/${a}/${b}/${hashHex}${ext}`
}
