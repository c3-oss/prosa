import { compress as zstdCompress, decompress as zstdDecompress } from 'zstd-napi';

// Below this size the overhead of zstd framing isn't worth it.
const COMPRESS_THRESHOLD_BYTES = 256;
const ZSTD_LEVEL = 3;

export type Compression = 'zstd' | 'none';

export interface CompressionResult {
  bytes: Buffer;
  compression: Compression;
}

export function compressBytes(input: Uint8Array): CompressionResult {
  if (input.byteLength < COMPRESS_THRESHOLD_BYTES) {
    return { bytes: Buffer.from(input), compression: 'none' };
  }
  const out = zstdCompress(Buffer.from(input), { compressionLevel: ZSTD_LEVEL });
  return { bytes: out, compression: 'zstd' };
}

export function decompressBytes(input: Buffer, compression: Compression): Buffer {
  if (compression === 'none') return input;
  return zstdDecompress(input);
}
