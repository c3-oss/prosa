import { createHash } from 'node:crypto'
import { blake3 as nobleBlake3 } from '@noble/hashes/blake3'
import { bytesToHex } from '@noble/hashes/utils'
import { blake3 as wasmBlake3 } from 'hash-wasm'

/**
 * Hash bytes with BLAKE3 and return lowercase hex.
 *
 * Uses the pure-JS @noble/hashes implementation to remain synchronous.
 * Call sites that are already async should use blake3HexAsync instead for
 * better throughput via the WASM implementation.
 */
export function blake3Hex(bytes: Uint8Array): string {
  return bytesToHex(nobleBlake3(bytes))
}

/**
 * Hash bytes with BLAKE3 and return lowercase hex.
 *
 * Uses the hash-wasm WASM implementation for better throughput on large
 * payloads. Output is byte-identical to blake3Hex for the same input.
 * Prefer this in async call sites (putBytes, flushPendingObjects, etc.).
 */
export async function blake3HexAsync(bytes: Uint8Array): Promise<string> {
  return wasmBlake3(bytes)
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
