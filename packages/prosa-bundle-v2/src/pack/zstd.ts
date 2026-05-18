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
 * larger window than `ZSTD_MAX_WINDOW_LOG` (CQ-027). The frame header is
 * inspected independently of any external "window log" claim so a
 * malicious pack cannot declare a small `zstd_window_log` while embedding
 * a frame that demands a larger window at decode time.
 */
export function zstdDecompress(data: Uint8Array): Uint8Array {
  const windowLog = parseZstdFrameWindowLog(data)
  if (windowLog !== null && windowLog > ZSTD_MAX_WINDOW_LOG) {
    throw new Error(`zstdDecompress: frame requires windowLog ${windowLog} > canonical max ${ZSTD_MAX_WINDOW_LOG}`)
  }
  return cachedDecompressor.decompress(Buffer.from(data))
}

/**
 * Parse the zstd frame header just enough to determine the required
 * window size (in log2). Returns `windowLog` for a regular frame or
 * `null` for skippable frames. Throws on any non-zstd byte stream.
 *
 * Layout per RFC 8478:
 *   Magic_Number             (4 bytes, little-endian) = 0xFD2FB528
 *   Frame_Header_Descriptor  (1 byte):
 *     bits 7-6: Frame_Content_Size_flag
 *     bit  5  : Single_Segment_flag
 *     bit  4  : Reserved (must be 0)
 *     bit  3  : Content_Checksum_flag
 *     bits 2-0: Dictionary_ID_flag
 *   Window_Descriptor        (1 byte, present iff Single_Segment_flag == 0)
 *     bits 7-3: Exponent
 *     bits 2-0: Mantissa
 *     Window_Size = (1 << (Exponent + 10))
 *                 + Mantissa * (1 << (Exponent + 10 - 3))
 *
 * When Single_Segment_flag == 1 there is no Window_Descriptor; Window_Size
 * equals Frame_Content_Size, and the FCS field follows the FHD.
 */
export function parseZstdFrameWindowLog(data: Uint8Array): number | null {
  if (data.length < 5) {
    throw new Error(`parseZstdFrameWindowLog: buffer too short (${data.length} < 5)`)
  }
  const m0 = data[0] as number
  const m1 = data[1] as number
  const m2 = data[2] as number
  const m3 = data[3] as number
  // Skippable frame magic: 0x184D2A50..0x184D2A5F (little-endian on disk).
  if (m1 === 0x2a && m2 === 0x4d && m3 === 0x18 && (m0 & 0xf0) === 0x50) {
    return null
  }
  // Regular zstd frame magic: 0xFD2FB528 (little-endian).
  if (!(m0 === 0x28 && m1 === 0xb5 && m2 === 0x2f && m3 === 0xfd)) {
    throw new Error(
      `parseZstdFrameWindowLog: not a zstd frame (magic ${m0.toString(16).padStart(2, '0')}${m1.toString(16).padStart(2, '0')}${m2.toString(16).padStart(2, '0')}${m3.toString(16).padStart(2, '0')})`,
    )
  }
  const fhd = data[4] as number
  const singleSegment = (fhd & 0x20) !== 0
  if (singleSegment) {
    const fcsFlag = (fhd & 0xc0) >> 6
    const fcsSize = fcsFlag === 0 ? 1 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
    if (data.length < 5 + fcsSize) {
      throw new Error('parseZstdFrameWindowLog: truncated frame (FCS)')
    }
    let fcs = 0n
    for (let i = 0; i < fcsSize; i++) {
      fcs |= BigInt(data[5 + i] as number) << BigInt(8 * i)
    }
    if (fcsSize === 2) fcs += 256n // FCS_flag=1 stores fcs-256.
    if (fcs === 0n) return 10
    let log = 0
    let v = fcs - 1n
    while (v > 0n) {
      log++
      v >>= 1n
    }
    return log
  }
  if (data.length < 6) {
    throw new Error('parseZstdFrameWindowLog: truncated frame (no Window_Descriptor)')
  }
  const wd = data[5] as number
  const exponent = (wd >> 3) & 0x1f
  const mantissa = wd & 0x07
  const baseLog = exponent + 10
  return mantissa === 0 ? baseLog : baseLog + 1
}
