// Sharding function: `blake3('prosa.shardkey.v2' || keyspace || canonicalKey)[0:8] mod 4`.
//
// Used to assign every canonical key to one of 4 shards so writes never
// cross shard boundaries.

import { blake3 } from '@noble/hashes/blake3'

import type { Keyspace } from './commands.js'

export const SHARD_COUNT = 4

const SHARD_DOMAIN = new TextEncoder().encode('prosa.shardkey.v2')

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/**
 * Map a (keyspace, canonical key) to a shard index in [0, SHARD_COUNT).
 *
 * The first 8 hash bytes are read as a big-endian u64 and reduced mod
 * SHARD_COUNT. Using big-endian (vs. little-endian) is a canonical pin —
 * cross-implementation routing requires both ends to agree.
 */
export function shardOf(keyspace: Keyspace, canonicalKey: Uint8Array): number {
  const hash = blake3(concat(SHARD_DOMAIN, new TextEncoder().encode(keyspace), canonicalKey))
  // Read first 8 bytes as a big-endian u64 via BigInt to avoid Number precision loss.
  let acc = 0n
  for (let i = 0; i < 8; i++) {
    acc = (acc << 8n) | BigInt(hash[i] as number)
  }
  return Number(acc % BigInt(SHARD_COUNT))
}
