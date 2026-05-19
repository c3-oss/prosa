// Cross-subcommand coherence test for the `prosa index-v2` CLI
// group. The individual subcommand tests in `index-v2.test.ts`
// each exercise a single wrapper; this file proves the surface
// *composes*: when a bundle is populated with a realistic
// mixture of SessionBlob packs + Parquet projection segments,
// independent subcommands produce mutually consistent JSON.
//
// The coherence assertions catch a class of bugs subcommand
// tests cannot — for example, an `epochs` filter that drops a
// session-bearing epoch while `sessions` still reports a pack
// there. Whether or not the individual subcommands pass, this
// test fails if their *joint* output contradicts itself.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const CLI_ENTRY = join(__dirname, '..', '..', 'src', 'bin', 'prosa.ts')

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    'node',
    ['--conditions=prosa-dev', '--import', '@swc-node/register/esm-register', CLI_ENTRY, ...args],
    { encoding: 'utf8', timeout: 60_000 },
  )
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('prosa index-v2 cross-subcommand coherence', () => {
  it('status / sessions / epochs / projection-segments / transcript / compaction-plan all agree on the same populated bundle', async () => {
    const { writeSessionBlobPack, zstdSessionBlobCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-coherence-'))

    // Populate the bundle:
    //   - SessionBlob packs: ses_alpha @ epochs 1 and 3; ses_bravo @ epoch 1.
    //   - Parquet projection segments: epochs 2 and 3 (with epoch 3
    //     overlapping the SessionBlob side).
    //   - 17 small `sessions.parquet` segments across epochs 4..20 to
    //     fire the compaction trigger for the `sessions` entity.
    async function writePack(sessionId: string, epoch: number, messageCount: number): Promise<void> {
      const messages = Array.from({ length: messageCount }, (_, i) => ({
        message_id: `msg_${sessionId}_${epoch}_${i}`,
        ordinal: i,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        timestamp: '2026-05-19T00:00:00.000Z',
        turn_id: `tur_${Math.floor(i / 2)}`,
        blocks: [
          {
            block_id: `blk_${i}_0`,
            block_type: 'text',
            body: { kind: 'inline' as const, text: `body ${i}`, byte_length: 6 },
          },
        ],
      }))
      const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, zstdSessionBlobCompressor)
      await mkdir(sessionBlobEpochDir(storeRoot, epoch), { recursive: true })
      await writeFile(sessionBlobPackPath(storeRoot, sessionId, epoch), result.pack)
    }
    await writePack('ses_alpha', 1, 4)
    await writePack('ses_alpha', 3, 2)
    await writePack('ses_bravo', 1, 5)

    async function plantSegment(epoch: number, file: string, size: number): Promise<void> {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), Buffer.alloc(size))
    }
    await plantSegment(2, 'messages.parquet', 100)
    await plantSegment(3, 'messages.parquet', 200)
    for (let epoch = 4; epoch <= 20; epoch++) {
      await plantSegment(epoch, 'sessions.parquet', 1024)
    }

    // Run the read-side subcommands.
    const status = JSON.parse(runCli(['index-v2', 'status', '--store', storeRoot]).stdout) as {
      session_summaries: Array<{ session_id: string; epochs: number[]; latest_epoch: number; message_count: number }>
      session_count: number
      session_blob_epochs: number[]
    }
    const sessions = JSON.parse(runCli(['index-v2', 'sessions', '--store', storeRoot]).stdout) as Array<{
      session_id: string
      epochs: number[]
      latest_epoch: number
      message_count: number
    }>
    const epochs = JSON.parse(runCli(['index-v2', 'epochs', '--store', storeRoot]).stdout) as number[]
    const projection = JSON.parse(runCli(['index-v2', 'projection-segments', '--store', storeRoot]).stdout) as Array<{
      entityType: string
      epoch: number
      byteLength: number
      path: string
    }>
    const projectionSummary = JSON.parse(
      runCli(['index-v2', 'projection-segments', '--store', storeRoot, '--summary']).stdout,
    ) as {
      total_segments: number
      total_bytes: number
      by_entity: Record<string, { count: number; bytes: number }>
      by_epoch: Record<string, { count: number; bytes: number }>
    }
    const compactionPlan = JSON.parse(runCli(['index-v2', 'compaction-plan', '--store', storeRoot]).stdout) as {
      empty: boolean
      entities: Array<{ entityType: string; reason: string; segmentsToMerge: Array<{ epoch: number }> }>
    }
    const alphaTranscript = JSON.parse(
      runCli(['index-v2', 'transcript', '--store', storeRoot, '--session-id', 'ses_alpha']).stdout,
    ) as { epoch: number; messages: unknown[] }
    const alphaTranscriptOlder = JSON.parse(
      runCli(['index-v2', 'transcript', '--store', storeRoot, '--session-id', 'ses_alpha', '--epoch', '1']).stdout,
    ) as { epoch: number; messages: unknown[] }

    // Coherence assertions:

    // 1. `sessions` and `status.session_summaries` agree row-for-row.
    expect(sessions.map((s) => s.session_id)).toEqual(status.session_summaries.map((s) => s.session_id))
    expect(status.session_count).toBe(sessions.length)
    expect(sessions.length).toBe(2)

    // 2. `session_blob_epochs` from status equals the union of every
    //    `epochs[]` in sessions, sorted ascending and deduplicated.
    const unionFromSessions = [...new Set(sessions.flatMap((s) => s.epochs))].sort((a, b) => a - b)
    expect(status.session_blob_epochs).toEqual(unionFromSessions)
    expect(unionFromSessions).toEqual([1, 3])

    // 3. `epochs` returns exactly the union of SessionBlob epochs +
    //    Parquet projection epochs (CQ-104 artifact-bearing).
    const projectionEpochs = [...new Set(projection.map((s) => s.epoch))].sort((a, b) => a - b)
    const expectedTouched = [...new Set([...unionFromSessions, ...projectionEpochs])].sort((a, b) => a - b)
    expect(epochs).toEqual(expectedTouched)

    // 4. `projection-segments` flat list and `--summary` rollup are
    //    self-consistent.
    expect(projectionSummary.total_segments).toBe(projection.length)
    expect(projectionSummary.total_bytes).toBe(projection.reduce((sum, s) => sum + s.byteLength, 0))
    for (const [entityType, rollup] of Object.entries(projectionSummary.by_entity)) {
      const rowsForEntity = projection.filter((s) => s.entityType === entityType)
      expect(rollup.count).toBe(rowsForEntity.length)
      expect(rollup.bytes).toBe(rowsForEntity.reduce((sum, s) => sum + s.byteLength, 0))
    }

    // 5. Compaction plan fires for `sessions` (17 small files); every
    //    segment it lists must come from an epoch that
    //    `projection-segments` also reports.
    expect(compactionPlan.empty).toBe(false)
    expect(compactionPlan.entities.map((e) => e.entityType)).toContain('sessions')
    const sessionsEntity = compactionPlan.entities.find((e) => e.entityType === 'sessions')
    expect(sessionsEntity?.reason).toBe('low_count_byte_ceiling')
    for (const segment of sessionsEntity?.segmentsToMerge ?? []) {
      expect(projectionEpochs).toContain(segment.epoch)
    }

    // 6. `transcript` without `--epoch` returns ses_alpha's latest
    //    pack (epoch 3, 2 messages); `--epoch 1` returns the older
    //    pack (4 messages). Cross-check against the inventory row.
    const alphaSummary = sessions.find((s) => s.session_id === 'ses_alpha')
    expect(alphaSummary?.latest_epoch).toBe(alphaTranscript.epoch)
    expect(alphaTranscript.epoch).toBe(3)
    expect(alphaTranscript.messages).toHaveLength(2)
    expect(alphaTranscriptOlder.epoch).toBe(1)
    expect(alphaTranscriptOlder.messages).toHaveLength(4)
  }, 120_000)

  it('maintenance dashboard rollups equal the per-subcommand totals on the same bundle', async () => {
    const { writeSessionBlobPack, zstdSessionBlobCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-maintenance-coh-'))

    // Plant: 1 SessionBlob pack + 17 small `sessions.parquet`
    // segments + persist a manifest (no compacted output → inconsistent).
    const messages = [
      {
        message_id: 'msg_000000',
        ordinal: 0,
        role: 'user' as const,
        timestamp: '2026-05-19T00:00:00.000Z',
        turn_id: 'tur_0',
        blocks: [
          {
            block_id: 'blk_0_0',
            block_type: 'text',
            body: { kind: 'inline' as const, text: 'hi', byte_length: 2 },
          },
        ],
      },
    ]
    const pack = writeSessionBlobPack({ session_id: 'ses_alpha', epoch: 1, messages }, zstdSessionBlobCompressor)
    await mkdir(sessionBlobEpochDir(storeRoot, 1), { recursive: true })
    await writeFile(sessionBlobPackPath(storeRoot, 'ses_alpha', 1), pack.pack)
    for (let epoch = 1; epoch <= 17; epoch++) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(1024))
    }
    runCli([
      'index-v2',
      'compaction-manifest',
      '--store',
      storeRoot,
      '--write',
      '--generated-at',
      '2026-05-19T12:00:00.000Z',
    ])

    // Read the maintenance dashboard.
    const maintenance = JSON.parse(runCli(['index-v2', 'maintenance', '--store', storeRoot]).stdout) as {
      status: { session_count: number }
      projection: { total_segments: number; total_bytes: number }
      compaction: { empty: boolean; entity_count: number }
      persisted_compactions: { count: number; consistent_count: number; inconsistent_count: number }
      gc: { candidate_count: number; safe_to_delete: { count: number }; blocked: { count: number } }
    }

    // Cross-reference each rollup against the corresponding
    // single-purpose subcommand.
    const status = JSON.parse(runCli(['index-v2', 'status', '--store', storeRoot]).stdout) as {
      session_count: number
    }
    const projection = JSON.parse(
      runCli(['index-v2', 'projection-segments', '--store', storeRoot, '--summary']).stdout,
    ) as { total_segments: number; total_bytes: number }
    const compactionPlan = JSON.parse(runCli(['index-v2', 'compaction-plan', '--store', storeRoot]).stdout) as {
      empty: boolean
      entities: unknown[]
    }
    const compactedOutputs = JSON.parse(
      runCli(['index-v2', 'compacted-outputs', '--store', storeRoot]).stdout,
    ) as Array<{ consistent: boolean }>
    const gcPlan = JSON.parse(runCli(['index-v2', 'gc-plan', '--store', storeRoot]).stdout) as {
      candidates: unknown[]
      safe_to_delete: { count: number }
      blocked: { count: number }
    }

    expect(maintenance.status.session_count).toBe(status.session_count)
    expect(maintenance.projection.total_segments).toBe(projection.total_segments)
    expect(maintenance.projection.total_bytes).toBe(projection.total_bytes)
    expect(maintenance.compaction.empty).toBe(compactionPlan.empty)
    expect(maintenance.compaction.entity_count).toBe(compactionPlan.entities.length)
    expect(maintenance.persisted_compactions.count).toBe(compactedOutputs.length)
    expect(maintenance.persisted_compactions.consistent_count).toBe(compactedOutputs.filter((r) => r.consistent).length)
    expect(maintenance.persisted_compactions.inconsistent_count).toBe(
      compactedOutputs.filter((r) => !r.consistent).length,
    )
    expect(maintenance.gc.candidate_count).toBe(gcPlan.candidates.length)
    expect(maintenance.gc.safe_to_delete.count).toBe(gcPlan.safe_to_delete.count)
    expect(maintenance.gc.blocked.count).toBe(gcPlan.blocked.count)
  }, 120_000)
})
