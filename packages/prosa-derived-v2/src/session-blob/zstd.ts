// Production zstd compressor/decompressor for SessionBlobPackV2.
//
// `writeSessionBlobPack` and `loadTranscriptPage` accept generic
// `(Uint8Array) => Uint8Array` callbacks so the byte layout, framing,
// and joint-constraint policy can be exercised in tests without
// pulling in a native compressor. This module wires the production
// codec: zstd via `zstd-napi`, sharing the bundle-v2 wrapper that
// already enforces the canonical window-log pin (`windowLog ≤ 23`,
// i.e. 8 MiB max window) and surfaces malicious-frame protection
// (CQ-027 in bundle-v2).
//
// Reusing `prosa-bundle-v2`'s wrapper has two benefits:
//
//   1. SessionBlob packs and CAS packs share a single zstd policy. A
//      change to the canonical window-log lands in one place.
//   2. The native binding stays out of `prosa-derived-v2`'s direct
//      dependency surface — only `zstd-napi`, which is already on the
//      workspace `allowBuilds` allowlist, transitively links via
//      bundle-v2.
//
// The exports are typed against `SessionBlobCompressor` and
// `SessionBlobDecompressor` from `./reader.js` (the writer accepts
// the matching callback signature). Callers pass them verbatim:
//
//     writeSessionBlobPack({ session_id, epoch, messages }, zstdSessionBlobCompressor)
//     loadTranscriptPage(pack, pageIndex, zstdSessionBlobDecompressor)
//
// The `header.compression` field of the resulting pack stays `'zstd'`
// (it always was — the identity compressor was a test affordance, not
// a contract claim). Production readers detect the codec by inspecting
// the frame magic; this wrapper enforces both the policy on write and
// the malicious-frame check on read.

import { zstdCompress, zstdDecompress } from '@c3-oss/prosa-bundle-v2'

import type { SessionBlobDecompressor } from './reader.js'

/**
 * Production zstd compressor for SessionBlobPackV2 page payloads.
 *
 * Uses the bundle-v2 wrapper, which delegates to `zstd-napi` with the
 * canonical level (3) and window-log (21). Output is a `Uint8Array`
 * over a freshly allocated buffer — safe to retain and concatenate.
 *
 * Throws when the requested window-log exceeds `ZSTD_MAX_WINDOW_LOG`
 * (the bundle-v2 wrapper enforces the canonical pin); SessionBlob
 * pages never need a window larger than 1 MiB so this is purely a
 * defence-in-depth guard.
 */
export function zstdSessionBlobCompressor(data: Uint8Array): Uint8Array {
  return zstdCompress(data)
}

/**
 * Production zstd decompressor for SessionBlobPackV2 page payloads.
 *
 * Parses the frame header before decompression and rejects frames
 * that request a window larger than the canonical
 * `ZSTD_MAX_WINDOW_LOG` (8 MiB). A tampered pack cannot force the
 * decoder to allocate unbounded memory — the same protection the
 * bundle-v2 CAS pack reader gets.
 *
 * Typed as `SessionBlobDecompressor` so callers can pass it directly
 * to `loadTranscriptPage` / `iterateTranscript`.
 */
export const zstdSessionBlobDecompressor: SessionBlobDecompressor = (data) => zstdDecompress(data)
