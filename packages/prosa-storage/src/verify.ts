import { blake3 } from '@noble/hashes/blake3'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { ObjectMeta, PutMeta } from './types.js'

export class ObjectVerificationError extends Error {
  override readonly name = 'ObjectVerificationError'
}

/**
 * Verifies that the declared metadata matches the bytes about to be stored.
 * Throws an {@link ObjectVerificationError} on any mismatch. Always called
 * before a successful `putIfAbsent` writes new bytes.
 */
export function verifyBytes(bytes: Uint8Array, meta: PutMeta): void {
  if (bytes.byteLength !== meta.compressedSize) {
    throw new ObjectVerificationError(
      `byte size mismatch (declared ${meta.compressedSize}, received ${bytes.byteLength})`,
    )
  }
  const computed = computeHashHex(bytes, meta.hashAlgorithm)
  if (computed.toLowerCase() !== meta.hash.toLowerCase()) {
    throw new ObjectVerificationError(`${meta.hashAlgorithm} mismatch (declared ${meta.hash}, computed ${computed})`)
  }
}

/**
 * Confirms that a repeated `putIfAbsent` for the same key declares the same
 * provenance as the row already stored. Conflicting bytes/metadata for an
 * existing key are rejected rather than silently accepted as no-ops.
 */
export function assertNoConflict(existing: ObjectMeta, incoming: PutMeta): void {
  if (existing.hash.toLowerCase() !== incoming.hash.toLowerCase()) {
    throw new ObjectVerificationError(
      `conflicting hash for existing object: stored=${existing.hash}, incoming=${incoming.hash}`,
    )
  }
  if (existing.hashAlgorithm !== incoming.hashAlgorithm) {
    throw new ObjectVerificationError(
      `conflicting hashAlgorithm: stored=${existing.hashAlgorithm}, incoming=${incoming.hashAlgorithm}`,
    )
  }
  if (existing.compressedSize !== incoming.compressedSize) {
    throw new ObjectVerificationError(
      `conflicting compressedSize: stored=${existing.compressedSize}, incoming=${incoming.compressedSize}`,
    )
  }
  if (existing.uncompressedSize !== incoming.uncompressedSize) {
    throw new ObjectVerificationError(
      `conflicting uncompressedSize: stored=${existing.uncompressedSize}, incoming=${incoming.uncompressedSize}`,
    )
  }
}

export function computeHashHex(bytes: Uint8Array, algorithm: 'blake3' | 'sha256'): string {
  switch (algorithm) {
    case 'blake3':
      return bytesToHex(blake3(bytes))
    case 'sha256':
      return bytesToHex(sha256(bytes))
  }
}
