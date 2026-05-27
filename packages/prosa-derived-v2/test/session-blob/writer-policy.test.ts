// SessionBlobPackV2 writer joint-constraint policy tests.

import { describe, expect, it } from 'vitest'

import {
  HARD_MESSAGES_PER_PAGE,
  MAX_INLINE_BLOCK_BYTES,
  MAX_PAGE_UNCOMPRESSED_BYTES,
  TARGET_MESSAGES_PER_PAGE,
  TARGET_PAGE_UNCOMPRESSED_BYTES,
} from '../../src/session-blob/types.js'
import { decideBlock, decideMessageBoundary } from '../../src/session-blob/writer-policy.js'

describe('decideBlock', () => {
  it('inlines a small block on an empty page', () => {
    const d = decideBlock({ currentBytes: 0, messageCount: 0 }, 1024)
    expect(d.kind).toBe('inline')
    expect(d.byte_length).toBe(1024)
  })

  it('spills oversize blocks (> MAX_INLINE_BLOCK_BYTES) to CAS regardless of page state', () => {
    const tooBig = MAX_INLINE_BLOCK_BYTES + 1
    const d = decideBlock({ currentBytes: 0, messageCount: 0 }, tooBig)
    expect(d.kind).toBe('cas_ref')
    if (d.kind === 'cas_ref') {
      expect(d.reason).toBe('oversize')
      expect(d.byte_length).toBe(tooBig)
    }
  })

  it('splits page when a small block would exceed MAX_PAGE_UNCOMPRESSED_BYTES on a non-empty page', () => {
    const d = decideBlock({ currentBytes: MAX_PAGE_UNCOMPRESSED_BYTES - 100, messageCount: 5 }, 200)
    expect(d.kind).toBe('split_page')
  })

  it('spills to CAS when a fresh page would still overflow on a single block', () => {
    // page is empty AND the block is > MAX_PAGE_UNCOMPRESSED but ≤ MAX_INLINE_BLOCK
    // can't happen (MAX_PAGE > MAX_INLINE_BLOCK), but emulate the
    // edge-case where currentBytes is at the cap with messageCount=0:
    const d = decideBlock({ currentBytes: MAX_PAGE_UNCOMPRESSED_BYTES, messageCount: 0 }, MAX_INLINE_BLOCK_BYTES)
    expect(d.kind).toBe('cas_ref')
    if (d.kind === 'cas_ref') expect(d.reason).toBe('page_would_be_empty')
  })

  it('rejects malformed negative/non-finite byte counts by spilling to CAS', () => {
    const a = decideBlock({ currentBytes: 0, messageCount: 0 }, -1)
    expect(a.kind).toBe('cas_ref')
    const b = decideBlock({ currentBytes: 0, messageCount: 0 }, Number.POSITIVE_INFINITY)
    expect(b.kind).toBe('cas_ref')
  })
})

describe('decideMessageBoundary', () => {
  it('appends while well under all caps', () => {
    const d = decideMessageBoundary({ currentBytes: 0, messageCount: 0 })
    expect(d.kind).toBe('append')
  })

  it('splits when the hard message cap is reached', () => {
    const d = decideMessageBoundary({ currentBytes: 1024, messageCount: HARD_MESSAGES_PER_PAGE })
    expect(d.kind).toBe('split_page')
    if (d.kind === 'split_page') expect(d.reason).toBe('hard_message_cap')
  })

  it('splits when both the soft message target and the byte target are crossed', () => {
    const d = decideMessageBoundary({
      currentBytes: TARGET_PAGE_UNCOMPRESSED_BYTES + 1,
      messageCount: TARGET_MESSAGES_PER_PAGE,
    })
    expect(d.kind).toBe('split_page')
  })

  it('splits when the soft byte target is crossed with at least one message', () => {
    const d = decideMessageBoundary({
      currentBytes: TARGET_PAGE_UNCOMPRESSED_BYTES,
      messageCount: 1,
    })
    expect(d.kind).toBe('split_page')
    if (d.kind === 'split_page') expect(d.reason).toBe('target_byte_budget')
  })

  it('does not split a single-message page that is still under the byte target', () => {
    const d = decideMessageBoundary({
      currentBytes: TARGET_PAGE_UNCOMPRESSED_BYTES - 1,
      messageCount: 1,
    })
    expect(d.kind).toBe('append')
  })

  it('simulated 5,000-small-message session paginates without overflowing caps', () => {
    // Drive the policy through a realistic mix: small text messages
    // averaging 4 KiB each, no oversize blocks. The simulation must
    // not exceed MAX_PAGE_UNCOMPRESSED_BYTES on any page and must
    // produce more than one page.
    const MESSAGES = 5000
    const PER_MESSAGE_BYTES = 4 * 1024
    let pages = 1
    let currentBytes = 0
    let messageCount = 0
    for (let i = 0; i < MESSAGES; i++) {
      // Between-message boundary check (skip for first message).
      if (i > 0) {
        const boundary = decideMessageBoundary({ currentBytes, messageCount })
        if (boundary.kind === 'split_page') {
          pages += 1
          currentBytes = 0
          messageCount = 0
        }
      }
      // Block placement check.
      const block = decideBlock({ currentBytes, messageCount }, PER_MESSAGE_BYTES)
      if (block.kind === 'split_page') {
        pages += 1
        currentBytes = 0
        messageCount = 0
      }
      // After any forced split, the block now fits on the fresh
      // page; commit it.
      currentBytes += PER_MESSAGE_BYTES
      messageCount += 1
      expect(currentBytes).toBeLessThanOrEqual(MAX_PAGE_UNCOMPRESSED_BYTES)
      expect(messageCount).toBeLessThanOrEqual(HARD_MESSAGES_PER_PAGE)
    }
    expect(pages).toBeGreaterThan(1)
  })
})
