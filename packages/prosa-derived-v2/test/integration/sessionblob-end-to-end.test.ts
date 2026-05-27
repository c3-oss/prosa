// SessionBlobPackV2 read-side end-to-end integration test.
//
// Each public read surface has its own unit tests; this test wires
// them up against a single realistic bundle (multiple sessions,
// multiple epochs, production zstd) and asserts the data flows
// through every layer correctly. Catches drift between layers
// without re-testing each unit.
//
// Pipeline exercised:
//
//   1. `writeSessionBlobPack` + `zstdSessionBlobCompressor` — emit
//      multi-session multi-epoch packs to disk.
//   2. `listSessionBlobEpochs` — discover the epoch set.
//   3. `listSessionBlobSessions` (per epoch) + `listAllSessionBlobSessions`
//      (union) — enumerate sessions.
//   4. `sessionBlobPackExists` — pre-flight probe.
//   5. `latestEpochForSession` — newest-epoch lookup.
//   6. `loadSessionBlobPack` — full pack load with digest re-verify.
//   7. `loadLatestSessionBlobPack` — newest-first load.
//   8. `readSessionBlobHeader` — header-only fast read.
//   9. `getSessionBlobSummary` — single inventory row.
//  10. `listSessionBlobSummaries` — bulk inventory.
//  11. `loadTranscriptFromBundle` (collect-all) + `iterateTranscriptFromBundle`
//      (streaming) — final transcript materialisation.
//  12. `bundleDerivedStatus` — top-level aggregator.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleDerivedStatus } from '../../src/bundle-status.js'
import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { sessionBlobPackExists } from '../../src/session-blob/exists.js'
import { readSessionBlobHeader } from '../../src/session-blob/header.js'
import { latestEpochForSession } from '../../src/session-blob/latest-epoch.js'
import { loadLatestSessionBlobPack } from '../../src/session-blob/latest.js'
import {
  listAllSessionBlobSessions,
  listSessionBlobEpochs,
  listSessionBlobSessions,
} from '../../src/session-blob/listing.js'
import { loadSessionBlobPack } from '../../src/session-blob/loader.js'
import { getSessionBlobSummary, listSessionBlobSummaries } from '../../src/session-blob/summary.js'
import { iterateTranscriptFromBundle, loadTranscriptFromBundle } from '../../src/session-blob/transcript-from-bundle.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'
import { zstdSessionBlobCompressor } from '../../src/session-blob/zstd.js'

interface SessionFixture {
  session_id: string
  /** Per-epoch message count emitted for this session. */
  emissions: Array<{ epoch: number; messageCount: number }>
}

const FIXTURE: SessionFixture[] = [
  {
    session_id: 'ses_alpha',
    emissions: [
      { epoch: 1, messageCount: 5 },
      { epoch: 3, messageCount: 12 },
      { epoch: 7, messageCount: 20 },
    ],
  },
  {
    session_id: 'ses_bravo',
    emissions: [
      { epoch: 3, messageCount: 8 },
      { epoch: 7, messageCount: 8 },
    ],
  },
  {
    session_id: 'ses_charlie',
    emissions: [{ epoch: 1, messageCount: 3 }],
  },
]

function mkMessage(i: number, sessionId: string): BlobMessageInput {
  const text = `[${sessionId}] message body ${i}`
  return {
    message_id: `${sessionId}__msg_${i.toString().padStart(6, '0')}`,
    ordinal: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    timestamp: `2026-05-19T00:00:${(i % 60).toString().padStart(2, '0')}.000Z`,
    turn_id: `${sessionId}__tur_${Math.floor(i / 2)}`,
    blocks: [
      {
        block_id: `${sessionId}__msg_${i}__blk_0`,
        block_type: 'text',
        body: { kind: 'inline', text, byte_length: new TextEncoder().encode(text).length },
      },
    ],
  }
}

describe('SessionBlobPackV2 read-side end-to-end pipeline', () => {
  let bundleRoot: string
  // Track expected pack digests so the integration test can assert
  // identity flows through every surface that exposes the digest.
  const expectedDigests = new Map<string, string>()

  beforeAll(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-int-sbv2-'))
    for (const session of FIXTURE) {
      for (const emission of session.emissions) {
        const messages = Array.from({ length: emission.messageCount }, (_, i) => mkMessage(i, session.session_id))
        const result = writeSessionBlobPack(
          { session_id: session.session_id, epoch: emission.epoch, messages },
          zstdSessionBlobCompressor,
        )
        const dir = sessionBlobEpochDir(bundleRoot, emission.epoch)
        await mkdir(dir, { recursive: true })
        await writeFile(sessionBlobPackPath(bundleRoot, session.session_id, emission.epoch), result.pack)
        expectedDigests.set(`${session.session_id}@${emission.epoch}`, result.pack_digest)
      }
    }
  })

  afterAll(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('listing surfaces report the expected epoch + session sets', async () => {
    expect(await listSessionBlobEpochs(bundleRoot)).toEqual([1, 3, 7])
    expect(await listSessionBlobSessions({ bundleRoot, epoch: 1 })).toEqual(['ses_alpha', 'ses_charlie'])
    expect(await listSessionBlobSessions({ bundleRoot, epoch: 3 })).toEqual(['ses_alpha', 'ses_bravo'])
    expect(await listSessionBlobSessions({ bundleRoot, epoch: 7 })).toEqual(['ses_alpha', 'ses_bravo'])
    expect(await listAllSessionBlobSessions(bundleRoot)).toEqual(['ses_alpha', 'ses_bravo', 'ses_charlie'])
  })

  it('existence probe is consistent with the listing', async () => {
    for (const session of FIXTURE) {
      const presentEpochs = new Set(session.emissions.map((e) => e.epoch))
      for (const epoch of [0, 1, 2, 3, 5, 7, 8]) {
        const expected = presentEpochs.has(epoch)
        expect(await sessionBlobPackExists({ bundleRoot, sessionId: session.session_id, epoch })).toBe(expected)
      }
    }
  })

  it('latest-epoch lookup returns the highest emission per session', async () => {
    expect(await latestEpochForSession({ bundleRoot, sessionId: 'ses_alpha' })).toBe(7)
    expect(await latestEpochForSession({ bundleRoot, sessionId: 'ses_bravo' })).toBe(7)
    expect(await latestEpochForSession({ bundleRoot, sessionId: 'ses_charlie' })).toBe(1)
    expect(await latestEpochForSession({ bundleRoot, sessionId: 'ses_never_written' })).toBeNull()
  })

  it('loadSessionBlobPack exposes the writer-emitted pack_digest verbatim', async () => {
    for (const session of FIXTURE) {
      for (const emission of session.emissions) {
        const loaded = await loadSessionBlobPack({
          bundleRoot,
          sessionId: session.session_id,
          epoch: emission.epoch,
        })
        const expected = expectedDigests.get(`${session.session_id}@${emission.epoch}`)
        expect(loaded.pack_digest).toBe(expected)
        expect(loaded.header.epoch).toBe(emission.epoch)
      }
    }
  })

  it('loadLatestSessionBlobPack matches the per-session newest-epoch pack', async () => {
    for (const session of FIXTURE) {
      const latestEmission = session.emissions[session.emissions.length - 1]!
      const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: session.session_id })
      expect(loaded.epoch).toBe(latestEmission.epoch)
      expect(loaded.pack_digest).toBe(expectedDigests.get(`${session.session_id}@${latestEmission.epoch}`))
    }
  })

  it('readSessionBlobHeader (omitted epoch) agrees with loadLatestSessionBlobPack on identity', async () => {
    for (const session of FIXTURE) {
      const head = await readSessionBlobHeader({ bundleRoot, sessionId: session.session_id })
      const loaded = await loadLatestSessionBlobPack({ bundleRoot, sessionId: session.session_id })
      expect(head.pack_digest).toBe(loaded.pack_digest)
      expect(head.epoch).toBe(loaded.epoch)
      expect(head.header.page_count).toBe(loaded.header.page_count)
    }
  })

  it('per-session summary matches the latest pack header counts', async () => {
    for (const session of FIXTURE) {
      const summary = await getSessionBlobSummary({ bundleRoot, sessionId: session.session_id })
      expect(summary).not.toBeNull()
      const presentEpochs = session.emissions.map((e) => e.epoch).sort((a, b) => a - b)
      expect(summary!.epochs).toEqual(presentEpochs)
      expect(summary!.latest_epoch).toBe(presentEpochs[presentEpochs.length - 1])
      const latestEmission = session.emissions[session.emissions.length - 1]!
      expect(summary!.message_count).toBe(latestEmission.messageCount)
      expect(summary!.ordinal_start).toBe(0)
      expect(summary!.ordinal_end).toBe(latestEmission.messageCount - 1)
    }
  })

  it('bulk summaries match individual per-session summaries', async () => {
    const bulk = await listSessionBlobSummaries(bundleRoot)
    expect(bulk.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo', 'ses_charlie'])
    for (const session of FIXTURE) {
      const single = await getSessionBlobSummary({ bundleRoot, sessionId: session.session_id })
      const bulkRow = bulk.find((s) => s.session_id === session.session_id)
      expect(bulkRow).toEqual(single)
    }
  })

  it('loadTranscriptFromBundle returns the latest pack messages in canonical order', async () => {
    for (const session of FIXTURE) {
      const result = await loadTranscriptFromBundle({ bundleRoot, sessionId: session.session_id })
      const latestEmission = session.emissions[session.emissions.length - 1]!
      expect(result.epoch).toBe(latestEmission.epoch)
      expect(result.messages).toHaveLength(latestEmission.messageCount)
      const ordinals = result.messages.map((m) => m.ordinal)
      expect(ordinals).toEqual(Array.from({ length: latestEmission.messageCount }, (_, i) => i))
      for (const msg of result.messages) {
        expect(msg.message_id).toMatch(new RegExp(`^${session.session_id}__msg_`))
        expect(msg.blocks[0]!.body).toEqual(
          expect.objectContaining({
            kind: 'inline',
            text: `[${session.session_id}] message body ${msg.ordinal}`,
          }),
        )
      }
    }
  })

  it('streaming iterator yields the same set as the collect-all loader (truncated by range)', async () => {
    const result = await iterateTranscriptFromBundle({
      bundleRoot,
      sessionId: 'ses_alpha',
      range: { startOrdinal: 5, endOrdinal: 9 },
    })
    const collected: number[] = []
    for (const msg of result.messages) collected.push(msg.ordinal)
    expect(collected).toEqual([5, 6, 7, 8, 9])
  })

  it('range filter on collect-all loader matches the streaming form', async () => {
    const collectAll = await loadTranscriptFromBundle({
      bundleRoot,
      sessionId: 'ses_alpha',
      range: { startOrdinal: 5, endOrdinal: 9 },
    })
    expect(collectAll.messages.map((m) => m.ordinal)).toEqual([5, 6, 7, 8, 9])
  })

  it('bundleDerivedStatus aggregates exactly what the individual surfaces report', async () => {
    const status = await bundleDerivedStatus(bundleRoot)
    expect(status.session_blob_epochs).toEqual(await listSessionBlobEpochs(bundleRoot))
    expect(status.session_count).toBe(3)
    expect(status.session_summaries.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo', 'ses_charlie'])
    // No Tantivy index for this fixture — the gates stay false.
    expect(status.tantivy.checkpoint_present).toBe(false)
    expect(status.tantivy.index_dir_valid).toBe(false)
    expect(status.tantivy.ready_for_read).toBe(false)
  })
})
