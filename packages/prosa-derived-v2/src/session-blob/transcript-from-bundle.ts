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
import { loadSessionBlobPack } from './loader.js'
import { type TranscriptIteratorOptions, type TranscriptMessage, iterateTranscript, loadTranscript } from './reader.js'
import { zstdSessionBlobDecompressor } from './zstd.js'

import type { SessionBlobDecompressor } from './reader.js'

export interface LoadTranscriptFromBundleInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Canonical session id (validated by `sessionBlobPackPath`). */
  sessionId: string
  /** Optional non-negative safe-integer epoch. When omitted, the
   *  newest epoch with a pack for this session is selected via
   *  `loadLatestSessionBlobPack`. When provided, that specific
   *  epoch's pack is loaded via `loadSessionBlobPack`; an ENOENT
   *  there means the caller asked for an epoch with no pack and
   *  surfaces unchanged. */
  epoch?: number
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
  if (input.epoch === undefined) {
    const pack = await loadLatestSessionBlobPack({ bundleRoot: input.bundleRoot, sessionId: input.sessionId })
    const decompress = input.decompress ?? zstdSessionBlobDecompressor
    const messages = loadTranscript(pack.bytes, decompress, input.range)
    return { epoch: pack.epoch, path: pack.path, pack_digest: pack.pack_digest, messages }
  }
  const pack = await loadSessionBlobPack({
    bundleRoot: input.bundleRoot,
    sessionId: input.sessionId,
    epoch: input.epoch,
  })
  const decompress = input.decompress ?? zstdSessionBlobDecompressor
  const messages = loadTranscript(pack.bytes, decompress, input.range)
  return { epoch: input.epoch, path: pack.path, pack_digest: pack.pack_digest, messages }
}

export interface IterableTranscriptFromBundle {
  /** Epoch the pack came from (= newest epoch that has a pack for
   *  this session). */
  epoch: number
  /** Resolved on-disk pack path. */
  path: string
  /** Pack digest recomputed from the bytes alone (re-verified by
   *  `loadLatestSessionBlobPack`). */
  pack_digest: string
  /** Lazy generator yielding `TranscriptMessage` records in canonical
   *  ordinal order, after multi-page fragment coalescing + range
   *  filtering. Pages outside the requested range are not
   *  decompressed; consumers may `break` early without paying for
   *  the remaining pages. */
  messages: Generator<TranscriptMessage, void, void>
}

/**
 * Streaming counterpart of `loadTranscriptFromBundle`. Same surface:
 *
 *   `(bundleRoot, sessionId) → { epoch, path, pack_digest, messages }`
 *
 * except `messages` is a pull-based generator instead of a fully
 * materialised array. Use this when paged-render flows (TUI scrolling,
 * MCP streaming responses, web pagination) only render a slice of the
 * transcript and would otherwise pay decompression cost for pages
 * they never display.
 *
 * The pack is loaded + verified eagerly (one full read + `verifyPackDigest`
 * pass), but per-page decompression is deferred to the generator:
 *
 *   const { epoch, messages } = await iterateTranscriptFromBundle({...})
 *   for (const msg of messages) {
 *     if (renderBudgetReached) break          // no decompression of remaining pages
 *     render(msg)
 *   }
 *
 * Failure semantics, validation, containment, and tamper detection
 * match `loadTranscriptFromBundle` exactly because both share the
 * same composed surfaces. Synchronous `sessionId` validation happens
 * inside `loadLatestSessionBlobPack` (CQ-100) before any filesystem
 * read.
 */
export async function iterateTranscriptFromBundle(
  input: LoadTranscriptFromBundleInput,
): Promise<IterableTranscriptFromBundle> {
  if (input.epoch === undefined) {
    const pack = await loadLatestSessionBlobPack({
      bundleRoot: input.bundleRoot,
      sessionId: input.sessionId,
    })
    const decompress = input.decompress ?? zstdSessionBlobDecompressor
    return {
      epoch: pack.epoch,
      path: pack.path,
      pack_digest: pack.pack_digest,
      messages: iterateTranscript(pack.bytes, decompress, input.range),
    }
  }
  const pack = await loadSessionBlobPack({
    bundleRoot: input.bundleRoot,
    sessionId: input.sessionId,
    epoch: input.epoch,
  })
  const decompress = input.decompress ?? zstdSessionBlobDecompressor
  return {
    epoch: input.epoch,
    path: pack.path,
    pack_digest: pack.pack_digest,
    messages: iterateTranscript(pack.bytes, decompress, input.range),
  }
}
