/**
 * CQ-009: bounded artifact preview decoding.
 *
 * Both the raw and zstd preview paths are required to stop pulling bytes
 * from the underlying object stream and stop producing decoded bytes once
 * the preview cap is reached. The zstd path uses the low-level
 * `DCtx.decompressStream` binding with an output buffer sized to the
 * remaining preview budget, so the decompressor is physically incapable of
 * producing more decoded bytes than the cap allows in a single call.
 */

// zstd-napi/binding is a CommonJS module (`module.exports = require(...)`),
// so ESM cannot statically detect its named exports. Use createRequire so
// both TypeScript (NodeNext resolution) and Node ESM agree at runtime.
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const zstdBinding = require_('zstd-napi/binding.js') as {
  DCtx: new () => {
    decompressStream(dst: Uint8Array, src: Uint8Array): [number, number, number]
  }
}
const { DCtx } = zstdBinding

export type BoundedDecodeResult = {
  decoded: Buffer
  truncated: boolean
  /** Total bytes produced by the decoder (≤ maxBytes + 1). */
  decodedBytesProduced: number
  /** Total compressed bytes pulled from the source stream. */
  srcBytesConsumed: number
}

/**
 * Decompress a zstd-compressed stream into at most `maxBytes` bytes of
 * decoded output. The implementation:
 *
 * 1. Sizes the destination buffer per call to exactly
 *    `maxBytes + 1 - decodedSoFar` so `decompressStream` cannot produce
 *    more than that many bytes in any single call.
 * 2. Stops reading from the source iterable as soon as the cap is hit.
 *
 * Returns both the bounded output and the metrics needed to prove that
 * neither the full uncompressed payload nor the full compressed payload
 * was processed.
 */
export async function decompressZstdBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<BoundedDecodeResult> {
  const dctx = new DCtx()
  const capPlusOne = maxBytes + 1
  let decodedTotal = 0
  let srcConsumedTotal = 0
  const chunks: Buffer[] = []

  outer: for await (const rawChunk of source) {
    let src = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    while (src.byteLength > 0) {
      const remaining = capPlusOne - decodedTotal
      if (remaining <= 0) break outer
      const dst = Buffer.allocUnsafe(remaining)
      const [, produced, consumed] = dctx.decompressStream(dst, src)
      if (produced > 0) {
        chunks.push(Buffer.from(dst.subarray(0, produced)))
        decodedTotal += produced
      }
      srcConsumedTotal += consumed
      src = src.subarray(consumed)
      if (decodedTotal >= capPlusOne) break outer
      if (produced === 0 && consumed === 0) break
    }
  }

  const truncated = decodedTotal > maxBytes
  const concatenated = Buffer.concat(chunks, decodedTotal)
  const decoded = truncated ? concatenated.subarray(0, maxBytes) : concatenated
  return {
    decoded,
    truncated,
    decodedBytesProduced: decodedTotal,
    srcBytesConsumed: srcConsumedTotal,
  }
}

/**
 * Read raw (uncompressed) bytes up to the preview cap. Bounded in the
 * same shape as the zstd variant for symmetric test coverage.
 */
export async function readRawBounded(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<BoundedDecodeResult> {
  const capPlusOne = maxBytes + 1
  let decodedTotal = 0
  let srcConsumedTotal = 0
  const chunks: Buffer[] = []

  for await (const rawChunk of source) {
    const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    srcConsumedTotal += buf.byteLength
    const remaining = capPlusOne - decodedTotal
    if (remaining <= 0) break
    const slice = buf.byteLength > remaining ? buf.subarray(0, remaining) : buf
    chunks.push(Buffer.from(slice))
    decodedTotal += slice.byteLength
    if (decodedTotal >= capPlusOne) break
  }

  const truncated = decodedTotal > maxBytes
  const concatenated = Buffer.concat(chunks, decodedTotal)
  const decoded = truncated ? concatenated.subarray(0, maxBytes) : concatenated
  return {
    decoded,
    truncated,
    decodedBytesProduced: decodedTotal,
    srcBytesConsumed: srcConsumedTotal,
  }
}
