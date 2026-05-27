// SessionBlobPackV2 writer joint constraint.
//
// The writer interleaves three caps per page:
//   - Uncompressed payload bytes  (≤ MAX_PAGE_UNCOMPRESSED_BYTES)
//   - Inline content-block size   (≤ MAX_INLINE_BLOCK_BYTES; larger
//                                  bodies go to CAS by reference)
//   - Hard message count          (≤ HARD_MESSAGES_PER_PAGE)
//
// `decideBlock` answers, per content block, whether the writer can
// inline it into the current page, must spill it to CAS, or has to
// start a new page first. `decideMessageBoundary` is the per-message
// hook the writer calls between messages to honour the message-count
// caps and the soft byte target.

import {
  HARD_MESSAGES_PER_PAGE,
  MAX_INLINE_BLOCK_BYTES,
  MAX_PAGE_UNCOMPRESSED_BYTES,
  TARGET_MESSAGES_PER_PAGE,
  TARGET_PAGE_UNCOMPRESSED_BYTES,
} from './types.js'

/** Outcome for a single content-block decision. */
export type BlockDecision =
  /** Inline the block into the current page. */
  | { kind: 'inline'; byte_length: number }
  /** Spill the block to CAS by reference (size > inline cap, or
   *  starting a fresh page would still not fit). */
  | { kind: 'cas_ref'; byte_length: number; reason: 'oversize' | 'page_would_be_empty' }
  /** Close the current page (which already has ≥1 message) and
   *  re-decide this block as the first block of the next page. */
  | { kind: 'split_page'; byte_length: number }

/** Outcome for a per-message boundary check. */
export type MessageBoundaryDecision =
  /** Keep appending messages to the current page. */
  | { kind: 'append' }
  /** Close the current page before appending the next message. */
  | { kind: 'split_page'; reason: 'hard_message_cap' | 'target_message_cap' | 'target_byte_budget' }

/** Snapshot of the in-flight page used to make a placement decision. */
export interface PageBuilderSnapshot {
  /** Bytes already committed to the current page. */
  currentBytes: number
  /** Messages already started on the current page. */
  messageCount: number
}

/** Per-block placement decision: must not strand a page with zero
 *  messages on a giant first block. */
export function decideBlock(page: PageBuilderSnapshot, blockBytes: number): BlockDecision {
  if (blockBytes < 0 || !Number.isFinite(blockBytes)) {
    // Defensive: spill to CAS rather than emit a malformed inline.
    return { kind: 'cas_ref', byte_length: 0, reason: 'oversize' }
  }
  if (blockBytes > MAX_INLINE_BLOCK_BYTES) {
    return { kind: 'cas_ref', byte_length: blockBytes, reason: 'oversize' }
  }
  if (page.currentBytes + blockBytes > MAX_PAGE_UNCOMPRESSED_BYTES) {
    if (page.messageCount === 0) {
      // Starting a new page would still place this block as the first
      // (and only) content; if it would already blow the cap, spill
      // it to CAS regardless.
      return { kind: 'cas_ref', byte_length: blockBytes, reason: 'page_would_be_empty' }
    }
    return { kind: 'split_page', byte_length: blockBytes }
  }
  return { kind: 'inline', byte_length: blockBytes }
}

/** Per-message boundary check: invoked between successive messages on
 *  the same session. Returns `split_page` when the next message must
 *  start a fresh page. */
export function decideMessageBoundary(page: PageBuilderSnapshot): MessageBoundaryDecision {
  // Hard message cap wins over everything else.
  if (page.messageCount >= HARD_MESSAGES_PER_PAGE) {
    return { kind: 'split_page', reason: 'hard_message_cap' }
  }
  // Soft message target + soft byte target — only split when both
  // suggest splitting, so we don't fragment small-message workloads.
  if (page.messageCount >= TARGET_MESSAGES_PER_PAGE && page.currentBytes >= TARGET_PAGE_UNCOMPRESSED_BYTES) {
    return { kind: 'split_page', reason: 'target_byte_budget' }
  }
  // Bytes-only soft target: split if we've already crossed the target
  // and the next message would push us further; the writer must not
  // emit a single-message page with a giant block here — that's the
  // block-decision path.
  if (page.currentBytes >= TARGET_PAGE_UNCOMPRESSED_BYTES && page.messageCount >= 1) {
    return { kind: 'split_page', reason: 'target_byte_budget' }
  }
  return { kind: 'append' }
}
