// End-to-end transcript loader for SessionBlobPackV2.
//
// `loadTranscriptFromBundle({ bundleRoot, sessionId, range?, decompress? })`
// is the single-call read path future CLI/MCP/web surfaces consume:
// pass a bundle root + session id, get the materialised transcript
// in canonical ordinal order. It composes:
//
//   1. `loadLatestSessionBlobPack` — finds the newest epoch with a
//      pack for this session and verifies the pack digest from the
//      bytes (the header field is never trusted for identity);
//   2. `iterateTranscript` / `loadTranscript` — walks every page in
//      ordinal order, coalesces multi-page fragments back into single
//      `TranscriptMessage` records, applies the optional ordinal
//      range filter while skipping out-of-range pages without
//      decompression, and validates per-page hashes;
//   3. `zstdSessionBlobDecompressor` (default) — the production
//      codec, with the bundle-v2 wrapper's CQ-027 malicious-frame
//      protection.
//
// Callers may pass a custom `decompress` callback when the pack was
// written with a non-production compressor (tests typically pass
// `identityDecompressor`). The default keeps the surface ergonomic.
//
// Failure semantics mirror the composed surfaces:
//
//   - `loadLatestSessionBlobPack` ENOENT (no epoch has a pack for
//     this session) propagates with `code: 'ENOENT'`.
//   - CQ-094 final-component / CQ-098 intermediate symlink
//     refusals propagate. Tamper detections from `verifyPackDigest`
//     and per-page `stored_hash` / `uncompressed_hash` checks
//     propagate.
//   - `sessionId` validation is delegated to `sessionBlobPackPath`
//     via the latest loader's first per-epoch attempt; an invalid
//     id throws synchronously before any meaningful filesystem
//     touch.

import { loadLatestSessionBlobPack } from './latest.js'
import { type TranscriptIteratorOptions, type TranscriptMessage, loadTranscript } from './reader.js'
import { zstdSessionBlobDecompressor } from './zstd.js'

import type { SessionBlobDecompressor } from './reader.js'

export interface LoadTranscriptFromBundleInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath`). */
  sessionId: string
  /** Optional inclusive ordinal range; out-of-range pages are
   *  skipped without decompression by `iterateTranscript`. */
  range?: TranscriptIteratorOptions
  /** Optional decompressor override. Defaults to the production zstd
   *  codec; tests typically pass `identityDecompressor` paired with
   *  the matching writer. */
  decompress?: SessionBlobDecompressor
}

export interface LoadedTranscriptFromBundle {
  /** Epoch the pack came from (= newest epoch that has a pack for
   *  this session). */
  epoch: number
  /** Resolved on-disk pack path. */
  path: string
  /** Pack digest recomputed from the bytes alone (re-verified by
   *  `loadLatestSessionBlobPack`). */
  pack_digest: string
  /** Materialised transcript messages in canonical ordinal order
   *  (after multi-page fragment coalescing + range filtering). */
  messages: TranscriptMessage[]
}

/**
 * Materialise a session's transcript end-to-end:
 *
 *   `(bundleRoot, sessionId) → TranscriptMessage[]`
 *
 * with the latest-epoch pack, per-page hash verification, and
 * fragment coalescing applied transparently.
 *
 * Use the optional `range` to bound the returned slice; out-of-range
 * pages are skipped without decompression so paged-render flows do
 * not pay for pages they never display.
 *
 * The collect-all `loadTranscript` helper is used internally because
 * the canonical use case (CLI/MCP read API) returns the full slice
 * to the caller. Streaming consumers can still call the underlying
 * `iterateTranscript` directly on `LoadedSessionBlobPack.bytes`
 * returned by `loadLatestSessionBlobPack`.
 */
export async function loadTranscriptFromBundle(
  input: LoadTranscriptFromBundleInput,
): Promise<LoadedTranscriptFromBundle> {
  const pack = await loadLatestSessionBlobPack({
    bundleRoot: input.bundleRoot,
    sessionId: input.sessionId,
  })
  const decompress = input.decompress ?? zstdSessionBlobDecompressor
  const messages = loadTranscript(pack.bytes, decompress, input.range)
  return {
    epoch: pack.epoch,
    path: pack.path,
    pack_digest: pack.pack_digest,
    messages,
  }
}
