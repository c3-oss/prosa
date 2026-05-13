import { compress as zstdCompress, decompress as zstdDecompress } from 'zstd-napi'

/**
 * Minimum payload size for zstd compression.
 *
 * Below this threshold the zstd frame overhead and CPU cost are not worth the
 * small storage savings.
 */
const COMPRESS_THRESHOLD_BYTES = 256

/**
 * Conservative zstd level used for importer throughput.
 */
const ZSTD_LEVEL = 3

/**
 * Stored object compression marker persisted in the `objects` table.
 */
export type Compression = 'zstd' | 'none'

/**
 * Bytes plus the storage codec needed to recover them.
 */
export interface CompressionResult {
  bytes: Buffer
  compression: Compression
}

/**
 * Compress bytes when they are large enough to benefit.
 *
 * Returns a Buffer regardless of input type. Small payloads are copied and
 * tagged as `none` so reads can skip decompression.
 */
export function compressBytes(input: Uint8Array): CompressionResult {
  if (input.byteLength < COMPRESS_THRESHOLD_BYTES) {
    return { bytes: Buffer.from(input), compression: 'none' }
  }
  const out = zstdCompress(Buffer.from(input), { compressionLevel: ZSTD_LEVEL })
  return { bytes: out, compression: 'zstd' }
}

/**
 * Reverse `compressBytes` according to the persisted compression marker.
 */
export function decompressBytes(input: Buffer, compression: Compression): Buffer {
  if (compression === 'none') return input
  return zstdDecompress(input)
}
