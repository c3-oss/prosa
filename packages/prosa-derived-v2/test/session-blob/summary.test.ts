// SessionBlobPackV2 aggregate summary tests.
//
// `getSessionBlobSummary({ bundleRoot, sessionId })` aggregates
// per-session inventory data: epoch list, latest pack identity,
// and header-level counts (messages, turns, tool calls, ordinal
// range). Returns `null` when the session has no pack anywhere.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { getSessionBlobSummary, listSessionBlobSummaries } from '../../src/session-blob/summary.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

const SESSION_ID = 'ses_summary_demo'

function inlineBlock(blockId: string, blockType: string, text: string) {
  return {
    block_id: blockId,
    block_type: blockType,
    body: { kind: 'inline' as const, text, byte_length: new TextEncoder().encode(text).length },
  }
}

function mkMessage(i: number, blocks: BlobMessageInput['blocks']): BlobMessageInput {
  return {
    message_id: `msg_${i.toString().padStart(6, '0')}`,
    ordinal: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: `2026-05-19T00:00:${(i % 60).toString().padStart(2, '0')}.000Z`,
    turn_id: `tur_${Math.floor(i / 2)}`,
    blocks,
  }
}

async function writePack(bundleRoot: string, sessionId: string, epoch: number, count: number) {
  const messages = Array.from({ length: count }, (_, i) =>
    mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `body ${i}`)]),
  )
  const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, epoch)
  await mkdir(dir, { recursive: true })
  await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), result.pack)
  return result
}

describe('getSessionBlobSummary', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-summary-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns null on a fresh bundle (no epochs)', async () => {
    expect(await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })).toBeNull()
  })

  it('returns null when epochs exist but none has a pack for this session', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 1), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other', 1), 'x')
    expect(await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })).toBeNull()
  })

  it('returns a single-epoch summary with aggregate counts from the latest header', async () => {
    const written = await writePack(bundleRoot, SESSION_ID, 3, 5)

    const summary = await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })

    expect(summary).not.toBeNull()
    expect(summary!.session_id).toBe(SESSION_ID)
    expect(summary!.epochs).toEqual([3])
    expect(summary!.latest_epoch).toBe(3)
    expect(summary!.latest_path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 3))
    expect(summary!.latest_pack_digest).toBe(written.pack_digest)
    expect(summary!.page_count).toBe(written.header.page_count)
    expect(summary!.message_count).toBe(5)
    expect(summary!.ordinal_start).toBe(0)
    expect(summary!.ordinal_end).toBe(4)
  })

  it('enumerates every epoch with a pack, sorted ascending, and uses the highest as latest', async () => {
    await writePack(bundleRoot, SESSION_ID, 1, 2)
    await writePack(bundleRoot, SESSION_ID, 4, 10)
    await writePack(bundleRoot, SESSION_ID, 9, 7)

    const summary = await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })

    expect(summary!.epochs).toEqual([1, 4, 9])
    expect(summary!.latest_epoch).toBe(9)
    expect(summary!.latest_path).toBe(sessionBlobPackPath(bundleRoot, SESSION_ID, 9))
    expect(summary!.message_count).toBe(7) // counts come from latest (epoch-9) header
    expect(summary!.ordinal_start).toBe(0)
    expect(summary!.ordinal_end).toBe(6)
  })

  it('drops epochs that exist but lack this session, keeping ones that have it', async () => {
    await writePack(bundleRoot, SESSION_ID, 1, 1)
    // Epoch 3 has another session, not this one.
    await mkdir(sessionBlobEpochDir(bundleRoot, 3), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other', 3), 'x')
    await writePack(bundleRoot, SESSION_ID, 5, 2)

    const summary = await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })

    expect(summary!.epochs).toEqual([1, 5])
    expect(summary!.latest_epoch).toBe(5)
  })

  it('aggregates per-page counts: messages/turns/tool-calls sum across the latest pack pages', async () => {
    // Writer assigns `turn_id = tur_{i/2}` and `tool_call_count`
    // tracks `is_tool_call` blocks. With 6 messages (no tool-call
    // blocks here) and pairs sharing turn ids, we just verify the
    // aggregates equal the header sums.
    const written = await writePack(bundleRoot, SESSION_ID, 2, 6)

    const summary = await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })

    const expectedMessages = written.header.pages.reduce((acc, p) => acc + p.message_count, 0)
    const expectedTurns = written.header.pages.reduce((acc, p) => acc + p.turn_count, 0)
    const expectedToolCalls = written.header.pages.reduce((acc, p) => acc + p.tool_call_count, 0)
    expect(summary!.message_count).toBe(expectedMessages)
    expect(summary!.turn_count).toBe(expectedTurns)
    expect(summary!.tool_call_count).toBe(expectedToolCalls)
  })

  it('rejects invalid sessionId synchronously (CQ-100 path on a fresh bundle)', async () => {
    await expect(getSessionBlobSummary({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(/characters outside/)
    await expect(getSessionBlobSummary({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    await expect(getSessionBlobSummary({ bundleRoot, sessionId: '' })).rejects.toThrow(/non-empty string/)
  })

  it('propagates parent CQ-098 rejection when `derived/session-blob` is a symlink', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-summary-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('treats per-epoch CQ-094 final-component symlinks as absent (skip)', async () => {
    await writePack(bundleRoot, SESSION_ID, 1, 1)
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-summary-cq094-'))
    try {
      await writeFile(join(external, 'external.pack'), 'x')
      await mkdir(sessionBlobEpochDir(bundleRoot, 5), { recursive: true })
      await symlink(join(external, 'external.pack'), sessionBlobPackPath(bundleRoot, SESSION_ID, 5))

      // Epoch 5's symlink is rejected by the existence probe; the
      // summary records only epoch 1.
      const summary = await getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })
      expect(summary!.epochs).toEqual([1])
      expect(summary!.latest_epoch).toBe(1)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    await writePack(bundleRoot, SESSION_ID, 7, 3)
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-summary-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      const summary = await getSessionBlobSummary({ bundleRoot: aliasRoot, sessionId: SESSION_ID })
      expect(summary!.epochs).toEqual([7])
      expect(summary!.latest_epoch).toBe(7)
      expect(summary!.message_count).toBe(3)
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('detects tampered latest pack via pack_digest re-verification', async () => {
    const written = await writePack(bundleRoot, SESSION_ID, 2, 2)
    // Tamper deep in the latest pack.
    const tampered = new Uint8Array(written.pack)
    tampered[tampered.length - 8] = (tampered[tampered.length - 8]! + 1) & 0xff
    await writeFile(sessionBlobPackPath(bundleRoot, SESSION_ID, 2), tampered)

    await expect(getSessionBlobSummary({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(
      /verifyPackDigest|mismatch|hash|stored_length/i,
    )
  })
})

describe('listSessionBlobSummaries', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-summaries-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] on a fresh bundle (no epochs)', async () => {
    expect(await listSessionBlobSummaries(bundleRoot)).toEqual([])
  })

  it('returns [] when epochs exist but no `.pack` files are present', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 1), { recursive: true })
    await mkdir(sessionBlobEpochDir(bundleRoot, 3), { recursive: true })
    expect(await listSessionBlobSessionsToSummaries(bundleRoot)).toEqual([])
  })

  it('returns one summary per session, sorted by session_id ascending', async () => {
    await writePack(bundleRoot, 'ses_charlie', 2, 4)
    await writePack(bundleRoot, 'ses_alpha', 1, 2)
    await writePack(bundleRoot, 'ses_bravo', 3, 6)

    const summaries = await listSessionBlobSummaries(bundleRoot)

    expect(summaries.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo', 'ses_charlie'])
    expect(summaries.map((s) => s.message_count)).toEqual([2, 6, 4])
  })

  it('produces one row per cross-epoch session even when the session appears in many epochs', async () => {
    // ses_alpha appears in epochs 1, 3, 5 — the bulk listing
    // should still surface exactly one row, with the latest epoch
    // (5) winning the aggregate counts.
    await writePack(bundleRoot, 'ses_alpha', 1, 1)
    await writePack(bundleRoot, 'ses_alpha', 3, 3)
    await writePack(bundleRoot, 'ses_alpha', 5, 7)
    await writePack(bundleRoot, 'ses_bravo', 3, 2)

    const summaries = await listSessionBlobSummaries(bundleRoot)

    expect(summaries.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo'])
    const alpha = summaries.find((s) => s.session_id === 'ses_alpha')!
    expect(alpha.epochs).toEqual([1, 3, 5])
    expect(alpha.latest_epoch).toBe(5)
    expect(alpha.message_count).toBe(7)
  })

  it('skips packs that the listing surface would not enumerate (CQ-099 / non-`.pack`)', async () => {
    await writePack(bundleRoot, 'ses_real', 1, 1)
    // Plant a CQ-099-rejected filename and a non-`.pack` file.
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_real', 1).replace('ses_real.pack', '.pack'), 'fake')
    await writeFile(join(sessionBlobEpochDir(bundleRoot, 1), 'README.md'), 'docs')

    const summaries = await listSessionBlobSummaries(bundleRoot)
    expect(summaries.map((s) => s.session_id)).toEqual(['ses_real'])
  })

  it('propagates parent CQ-098 rejection when `derived/session-blob` is a symlink', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-summaries-cq098-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(listSessionBlobSummaries(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    await writePack(bundleRoot, 'ses_real', 2, 3)
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-summaries-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      const summaries = await listSessionBlobSummaries(aliasRoot)
      expect(summaries.map((s) => s.session_id)).toEqual(['ses_real'])
      expect(summaries[0]!.message_count).toBe(3)
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('every summary in the result has populated metadata (no null slots)', async () => {
    await writePack(bundleRoot, 'ses_a', 1, 2)
    await writePack(bundleRoot, 'ses_b', 1, 5)
    await writePack(bundleRoot, 'ses_c', 2, 1)

    const summaries = await listSessionBlobSummaries(bundleRoot)

    expect(summaries).toHaveLength(3)
    for (const summary of summaries) {
      expect(summary.session_id).toBeTruthy()
      expect(summary.epochs.length).toBeGreaterThan(0)
      expect(summary.latest_epoch).toBe(summary.epochs.at(-1))
      expect(summary.message_count).toBeGreaterThan(0)
      expect(summary.latest_pack_digest).toMatch(/^blake3:[0-9a-f]{64}$/)
    }
  })
})

// `listSessionBlobSummaries` returns [] on empty-epoch-dirs because
// `listAllSessionBlobSessions` returns [] when no `.pack` files are
// found; this small alias exists only to keep the test phrasing
// honest about the composed surface.
async function listSessionBlobSessionsToSummaries(bundleRoot: string) {
  return listSessionBlobSummaries(bundleRoot)
}
