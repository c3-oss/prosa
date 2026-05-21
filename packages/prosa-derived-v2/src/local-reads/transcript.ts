// Local-bundle implementation of `prosa read transcript <session_id>`.
//
// Thin wrapper over `loadTranscriptFromBundle` (the existing session-
// blob reader). The CLI layer renders the returned messages via the
// shared `formatTranscriptTextV2` / `formatTranscriptMarkdownV2`
// helpers, so this module only needs to surface the rows.

import { loadTranscriptFromBundle } from '../session-blob/transcript-from-bundle.js'
import { zstdSessionBlobDecompressor } from '../session-blob/zstd.js'
import { loadBundleHead } from './head.js'

export type LoadTranscriptLocalOptions = {
  bundleRoot: string
  sessionId: string
  /** Optional explicit epoch; defaults to head.epoch. */
  epoch?: number
}

/**
 * Resolve and load the latest session-blob pack for `sessionId`,
 * returning the messages the CLI renders to text/markdown/json. The
 * decoder honours `zstdSessionBlobDecompressor` for the production
 * codec; throws when the pack is missing.
 */
export async function loadTranscriptLocal(options: LoadTranscriptLocalOptions): Promise<{
  bundleRoot: string
  sessionId: string
  epoch: number
  messages: Awaited<ReturnType<typeof loadTranscriptFromBundle>>['messages']
}> {
  const epoch = options.epoch ?? (await loadBundleHead(options.bundleRoot)).epoch
  const loaded = await loadTranscriptFromBundle({
    bundleRoot: options.bundleRoot,
    sessionId: options.sessionId,
    epoch,
    decompress: zstdSessionBlobDecompressor,
  })
  return {
    bundleRoot: options.bundleRoot,
    sessionId: options.sessionId,
    epoch: loaded.epoch,
    messages: loaded.messages,
  }
}
