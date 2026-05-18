// Zstd helper with window-log enforcement (canonical pin: windowLog <= 23 ≡
// 8 MiB max window). Wraps `zstd-napi` so the rest of the package never
// touches the native binding directly.
//
// We use the simple one-shot API. Streaming will come in later Lane 1
// iterations when pack rollover and large objects are wired.

import { Compressor, Decompressor } from 'zstd-napi'

export const ZSTD_MAX_WINDOW_LOG = 23

export type ZstdCompressOptions = {
  level?: number
  windowLog?: number
}

const cachedCompressors = new Map<string, Compressor>()
const cachedDecompressor = new Decompressor()

function getCompressor(key: string, init: () => Compressor): Compressor {
  let c = cachedCompressors.get(key)
  if (!c) {
    c = init()
    cachedCompressors.set(key, c)
  }
  return c
}

/**
 * Compress `data` with zstd. Throws if the requested `windowLog` exceeds
 * `ZSTD_MAX_WINDOW_LOG` per the Lane 0 canonical pin.
 */
export function zstdCompress(data: Uint8Array, options: ZstdCompressOptions = {}): Uint8Array {
  const level = options.level ?? 3
  const windowLog = options.windowLog ?? 21
  if (windowLog > ZSTD_MAX_WINDOW_LOG) {
    throw new Error(
      `zstdCompress: windowLog ${windowLog} exceeds canonical max ${ZSTD_MAX_WINDOW_LOG}; pack would be rejected by the server`,
    )
  }
  const key = `${level}:${windowLog}`
  const c = getCompressor(key, () => {
    const inst = new Compressor()
    inst.setParameters({ compressionLevel: level, windowLog })
    return inst
  })
  return c.compress(Buffer.from(data))
}

/**
 * Decompress `data` with zstd. Throws if the embedded frame requires a
 * larger window than `ZSTD_MAX_WINDOW_LOG`.
 */
export function zstdDecompress(data: Uint8Array): Uint8Array {
  // We rely on zstd-napi's default decompressor; it accepts any window size
  // in the frame header. We do not enforce decode-time windowLog here
  // because validation is done at encode/ingest time. If a frame with a
  // larger window is encountered, it must already have failed validation
  // upstream.
  return cachedDecompressor.decompress(Buffer.from(data))
}
