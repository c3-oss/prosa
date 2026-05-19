// Integration tests for `prosa index-v2 status` — the Lane 3 CLI
// surface that wraps `bundleDerivedStatus` from
// `@c3-oss/prosa-derived-v2`. We spawn the CLI as a subprocess so
// the test exercises the same `commander` wiring real users hit;
// the assertions inspect the printed JSON snapshot.
//
// Lane 3 lists `prosa index-v2 status` as a deliverable alongside
// `prosa index-v2 tantivy` (Tantivy writer, blocked on the native
// binding) and `prosa export-v2 parquet` (blocked on the DuckDB
// runtime executor). The `status` form is pure-read and can ship
// independently.

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

interface StatusSnapshot {
  tantivy: {
    checkpoint_present: boolean
    index_dir_valid: boolean
    ready_for_read: boolean
    current_schema_fingerprint: string
  }
  session_summaries: Array<{ session_id: string }>
  session_count: number
  session_blob_epochs: number[]
}

describe('prosa index-v2 CLI', () => {
  it('`index-v2 --help` lists all subcommands (status, sessions, epochs, analytics-views, projection-segments, tantivy-rebuild-plan, compaction-plan, transcript)', async () => {
    const r = runCli(['index-v2', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Bundle v2 derived-layer index commands')
    expect(r.stdout).toContain('status')
    expect(r.stdout).toContain('sessions')
    expect(r.stdout).toContain('epochs')
    expect(r.stdout).toContain('analytics-views')
    expect(r.stdout).toContain('projection-segments')
    expect(r.stdout).toContain('tantivy-rebuild-plan')
    expect(r.stdout).toContain('compaction-plan')
    expect(r.stdout).toContain('transcript')
  })

  it('`index-v2 status --help` documents --store', async () => {
    const r = runCli(['index-v2', 'status', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Print the combined Tantivy + SessionBlob status snapshot')
    expect(r.stdout).toContain('--store')
  })

  it('`index-v2 status` against a fresh (nonexistent) bundle prints the empty snapshot', async () => {
    // Point at a path that does not exist on disk yet. `bundleDerivedStatus`
    // is documented to collapse to the fresh-bundle snapshot rather than
    // error — that contract is what makes the command safe to script.
    const storeRoot = join(await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-')), 'never-initialised')
    const r = runCli(['index-v2', 'status', '--store', storeRoot])
    expect(r.status).toBe(0)
    const snapshot = JSON.parse(r.stdout) as StatusSnapshot
    expect(snapshot.tantivy.checkpoint_present).toBe(false)
    expect(snapshot.tantivy.index_dir_valid).toBe(false)
    expect(snapshot.tantivy.ready_for_read).toBe(false)
    expect(typeof snapshot.tantivy.current_schema_fingerprint).toBe('string')
    expect(snapshot.session_summaries).toEqual([])
    expect(snapshot.session_count).toBe(0)
    expect(snapshot.session_blob_epochs).toEqual([])
  })

  it('`index-v2 status` reflects SessionBlob packs that have been written to the bundle', async () => {
    const { writeSessionBlobPack, identityCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))

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
            body: { kind: 'inline' as const, text: 'hello', byte_length: 5 },
          },
        ],
      },
    ]
    const result = writeSessionBlobPack({ session_id: 'ses_alpha', epoch: 1, messages }, identityCompressor)
    await mkdir(sessionBlobEpochDir(storeRoot, 1), { recursive: true })
    await writeFile(sessionBlobPackPath(storeRoot, 'ses_alpha', 1), result.pack)

    const r = runCli(['index-v2', 'status', '--store', storeRoot])
    expect(r.status).toBe(0)
    const snapshot = JSON.parse(r.stdout) as StatusSnapshot
    expect(snapshot.session_summaries.map((s) => s.session_id)).toEqual(['ses_alpha'])
    expect(snapshot.session_count).toBe(1)
    expect(snapshot.session_blob_epochs).toEqual([1])
    // No Tantivy index has been written.
    expect(snapshot.tantivy.checkpoint_present).toBe(false)
    expect(snapshot.tantivy.ready_for_read).toBe(false)
  })

  it('`index-v2 status` fails when --store is missing', async () => {
    const r = runCli(['index-v2', 'status'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--store/i)
  })

  it('`index-v2 sessions --help` documents --store', async () => {
    const r = runCli(['index-v2', 'sessions', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SessionBlob inventory')
    expect(r.stdout).toContain('--store')
  })

  it('`index-v2 sessions` against a fresh bundle prints []', async () => {
    const storeRoot = join(await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-')), 'never-initialised')
    const r = runCli(['index-v2', 'sessions', '--store', storeRoot])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([])
  })

  it('`index-v2 sessions` reflects SessionBlob inventory rows when packs exist', async () => {
    const { writeSessionBlobPack, identityCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))

    async function writePack(sessionId: string, epoch: number) {
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
              body: { kind: 'inline' as const, text: 'hello', byte_length: 5 },
            },
          ],
        },
      ]
      const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
      await mkdir(sessionBlobEpochDir(storeRoot, epoch), { recursive: true })
      await writeFile(sessionBlobPackPath(storeRoot, sessionId, epoch), result.pack)
    }

    await writePack('ses_alpha', 1)
    await writePack('ses_bravo', 1)
    await writePack('ses_alpha', 3) // newer epoch for alpha

    const r = runCli(['index-v2', 'sessions', '--store', storeRoot])
    expect(r.status).toBe(0)
    const summaries = JSON.parse(r.stdout) as Array<{
      session_id: string
      epochs: number[]
      latest_epoch: number
      message_count: number
    }>
    expect(summaries.map((s) => s.session_id)).toEqual(['ses_alpha', 'ses_bravo'])
    const alpha = summaries.find((s) => s.session_id === 'ses_alpha')
    const bravo = summaries.find((s) => s.session_id === 'ses_bravo')
    expect(alpha?.epochs).toEqual([1, 3])
    expect(alpha?.latest_epoch).toBe(3)
    expect(bravo?.epochs).toEqual([1])
    expect(bravo?.latest_epoch).toBe(1)
    expect(alpha?.message_count).toBe(1)
  })

  it('`index-v2 sessions` fails when --store is missing', async () => {
    const r = runCli(['index-v2', 'sessions'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--store/i)
  })

  it('`index-v2 epochs --help` documents --store', async () => {
    const r = runCli(['index-v2', 'epochs', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('sorted set of epoch numbers')
    expect(r.stdout).toContain('--store')
  })

  it('`index-v2 epochs` against a fresh bundle prints []', async () => {
    const storeRoot = join(await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-')), 'never-initialised')
    const r = runCli(['index-v2', 'epochs', '--store', storeRoot])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([])
  })

  it('`index-v2 epochs` returns the sorted deduplicated union of SessionBlob + projection epochs', async () => {
    const { writeSessionBlobPack, identityCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))

    // SessionBlob packs at epochs 1, 4
    for (const [sessionId, epoch] of [
      ['ses_alpha', 1],
      ['ses_bravo', 4],
    ] as const) {
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
      const result = writeSessionBlobPack({ session_id: sessionId, epoch, messages }, identityCompressor)
      await mkdir(sessionBlobEpochDir(storeRoot, epoch), { recursive: true })
      await writeFile(sessionBlobPackPath(storeRoot, sessionId, epoch), result.pack)
    }
    // Projection segments at epochs 2, 4 (4 overlaps)
    for (const epoch of [2, 4]) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(100))
    }

    const r = runCli(['index-v2', 'epochs', '--store', storeRoot])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([1, 2, 4])
  })

  it('`index-v2 epochs` fails when --store is missing', async () => {
    const r = runCli(['index-v2', 'epochs'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--store/i)
  })

  it('`index-v2 analytics-views --help` documents the catalog and takes no --store option', async () => {
    const r = runCli(['index-v2', 'analytics-views', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('analytics-view catalog')
    // No `--store <path>` option line should appear in the Options block.
    // (The description does mention "--store" prose-style; what we are
    // really asserting is that this subcommand does not require one.)
    expect(r.stdout).not.toMatch(/--store\s+<path>/)
  })

  it('`index-v2 analytics-views` prints the five canonical view descriptors', async () => {
    const r = runCli(['index-v2', 'analytics-views'])
    expect(r.status).toBe(0)
    const catalog = JSON.parse(r.stdout) as Array<{
      name: string
      columns: string[]
      sql: string
    }>
    expect(catalog.map((v) => v.name)).toEqual([
      'session_facts',
      'tool_usage_facts',
      'error_facts',
      'model_usage',
      'project_activity',
    ])
    for (const view of catalog) {
      expect(Array.isArray(view.columns)).toBe(true)
      expect(view.columns.length).toBeGreaterThan(0)
      expect(typeof view.sql).toBe('string')
      expect(view.sql).toMatch(/CREATE OR REPLACE VIEW/i)
      expect(view.sql).toContain(view.name)
    }
  })

  it('`index-v2 projection-segments --help` documents --store and --summary', async () => {
    const r = runCli(['index-v2', 'projection-segments', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Parquet projection segments')
    expect(r.stdout).toContain('--store')
    expect(r.stdout).toContain('--summary')
  })

  it('`index-v2 projection-segments` against a fresh bundle prints []', async () => {
    const storeRoot = join(await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-')), 'never-initialised')
    const r = runCli(['index-v2', 'projection-segments', '--store', storeRoot])
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual([])
  })

  it('`index-v2 projection-segments` reflects planted Parquet segments across epochs', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    // Plant two segments across two epochs: epoch 1 sessions.parquet (100B),
    // epoch 2 messages.parquet (300B). The listing returns one ProjectionSegment
    // per file with `{ entityType, epoch, path, byteLength }`.
    for (const [epoch, file, size] of [
      [1, 'sessions.parquet', 100],
      [2, 'messages.parquet', 300],
    ] as const) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), Buffer.alloc(size))
    }

    const r = runCli(['index-v2', 'projection-segments', '--store', storeRoot])
    expect(r.status).toBe(0)
    const segments = JSON.parse(r.stdout) as Array<{
      entityType: string
      epoch: number
      path: string
      byteLength: number
    }>
    expect(segments).toHaveLength(2)
    expect(segments.map((s) => ({ entityType: s.entityType, epoch: s.epoch, byteLength: s.byteLength }))).toEqual([
      { entityType: 'sessions', epoch: 1, byteLength: 100 },
      { entityType: 'messages', epoch: 2, byteLength: 300 },
    ])
  })

  it('`index-v2 projection-segments --summary` emits the byte+count rollup', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    for (const [epoch, file, size] of [
      [1, 'sessions.parquet', 100],
      [1, 'messages.parquet', 200],
      [2, 'sessions.parquet', 400],
    ] as const) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), Buffer.alloc(size))
    }

    const r = runCli(['index-v2', 'projection-segments', '--store', storeRoot, '--summary'])
    expect(r.status).toBe(0)
    const summary = JSON.parse(r.stdout) as {
      total_bytes: number
      total_segments: number
      by_entity: Record<string, { count: number; bytes: number }>
      by_epoch: Record<string, { count: number; bytes: number }>
    }
    expect(summary.total_segments).toBe(3)
    expect(summary.total_bytes).toBe(700)
    expect(summary.by_entity.sessions).toEqual({ count: 2, bytes: 500 })
    expect(summary.by_entity.messages).toEqual({ count: 1, bytes: 200 })
    expect(summary.by_epoch['1']).toEqual({ count: 2, bytes: 300 })
    expect(summary.by_epoch['2']).toEqual({ count: 1, bytes: 400 })
  })

  it('`index-v2 projection-segments` fails when --store is missing', async () => {
    const r = runCli(['index-v2', 'projection-segments'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--store/i)
  })

  it('`index-v2 tantivy-rebuild-plan --help` documents --store, --current-max-rowid, --overwrite', async () => {
    const r = runCli(['index-v2', 'tantivy-rebuild-plan', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Tantivy rebuild plan')
    expect(r.stdout).toContain('--store')
    expect(r.stdout).toContain('--current-max-rowid')
    expect(r.stdout).toContain('--overwrite')
  })

  it('`index-v2 tantivy-rebuild-plan` on a fresh bundle returns full / index_dir_invalid', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli(['index-v2', 'tantivy-rebuild-plan', '--store', storeRoot, '--current-max-rowid', '0'])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout) as {
      plan: { kind: string; reason: string; fingerprint: string; currentMaxRowid: number }
      checkpoint: { last_indexed_rowid: number | null; schema_fingerprint: string | null; status: string | null }
      indexDirValid: boolean
    }
    expect(result.plan.kind).toBe('full')
    expect(result.plan.reason).toBe('index_dir_invalid')
    expect(result.plan.currentMaxRowid).toBe(0)
    expect(typeof result.plan.fingerprint).toBe('string')
    expect(result.plan.fingerprint.length).toBeGreaterThan(0)
    expect(result.indexDirValid).toBe(false)
    expect(result.checkpoint.last_indexed_rowid).toBe(null)
    expect(result.checkpoint.status).toBe(null)
  })

  it('`index-v2 tantivy-rebuild-plan --overwrite` forces caller_requested_overwrite', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli([
      'index-v2',
      'tantivy-rebuild-plan',
      '--store',
      storeRoot,
      '--current-max-rowid',
      '42',
      '--overwrite',
    ])
    expect(r.status).toBe(0)
    const result = JSON.parse(r.stdout) as {
      plan: { kind: string; reason: string; currentMaxRowid: number }
    }
    expect(result.plan.kind).toBe('full')
    expect(result.plan.reason).toBe('caller_requested_overwrite')
    expect(result.plan.currentMaxRowid).toBe(42)
  })

  it('`index-v2 tantivy-rebuild-plan` rejects a negative --current-max-rowid', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli(['index-v2', 'tantivy-rebuild-plan', '--store', storeRoot, '--current-max-rowid', '-5'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/invalid --current-max-rowid/i)
  })

  it('`index-v2 tantivy-rebuild-plan` fails when --current-max-rowid is missing', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli(['index-v2', 'tantivy-rebuild-plan', '--store', storeRoot])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--current-max-rowid/i)
  })

  it('`index-v2 compaction-plan --help` documents --store', async () => {
    const r = runCli(['index-v2', 'compaction-plan', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Parquet compaction plan')
    expect(r.stdout).toContain('--store')
  })

  it('`index-v2 compaction-plan` against a fresh bundle prints an empty plan', async () => {
    const storeRoot = join(await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-')), 'never-initialised')
    const r = runCli(['index-v2', 'compaction-plan', '--store', storeRoot])
    expect(r.status).toBe(0)
    const plan = JSON.parse(r.stdout) as { empty: boolean; entities: unknown[] }
    expect(plan.empty).toBe(true)
    expect(plan.entities).toEqual([])
  })

  it('`index-v2 compaction-plan` fires when 17 small projection segments exist for an entity', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    // Plant 17 tiny `sessions.parquet` segments across 17 epochs — each
    // <32 MiB ("small") + total <256 MiB → fires the `low_count_byte_ceiling`
    // trigger (>16 small files AND smallTotalBytes < 256 MiB).
    for (let epoch = 1; epoch <= 17; epoch++) {
      const dir = join(storeRoot, 'epochs', String(epoch), 'projection')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'sessions.parquet'), Buffer.alloc(1024))
    }

    const r = runCli(['index-v2', 'compaction-plan', '--store', storeRoot])
    expect(r.status).toBe(0)
    const plan = JSON.parse(r.stdout) as {
      empty: boolean
      entities: Array<{
        entityType: string
        reason: string
        segmentsToMerge: Array<{ path: string; byteLength: number; epoch: number }>
        outputPath: string
        totalBytesIn: number
      }>
    }
    expect(plan.empty).toBe(false)
    expect(plan.entities).toHaveLength(1)
    const [sessionsPlan] = plan.entities
    expect(sessionsPlan?.entityType).toBe('sessions')
    expect(sessionsPlan?.reason).toBe('low_count_byte_ceiling')
    expect(sessionsPlan?.segmentsToMerge).toHaveLength(17)
    expect(sessionsPlan?.totalBytesIn).toBe(17 * 1024)
    expect(typeof sessionsPlan?.outputPath).toBe('string')
    expect(sessionsPlan?.outputPath.length).toBeGreaterThan(0)
  })

  it('`index-v2 compaction-plan` fails when --store is missing', async () => {
    const r = runCli(['index-v2', 'compaction-plan'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--store/i)
  })

  it('`index-v2 transcript --help` documents --store and --session-id', async () => {
    const r = runCli(['index-v2', 'transcript', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("Print a session's latest-epoch transcript")
    expect(r.stdout).toContain('--store')
    expect(r.stdout).toContain('--session-id')
  })

  it('`index-v2 transcript` round-trips a real zstd-compressed pack and prints the messages', async () => {
    const { writeSessionBlobPack, zstdSessionBlobCompressor } = await import('@c3-oss/prosa-derived-v2')
    const { sessionBlobEpochDir, sessionBlobPackPath } = await import('@c3-oss/prosa-derived-v2')
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))

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
            body: { kind: 'inline' as const, text: 'hello world', byte_length: 11 },
          },
        ],
      },
      {
        message_id: 'msg_000001',
        ordinal: 1,
        role: 'assistant' as const,
        timestamp: '2026-05-19T00:00:01.000Z',
        turn_id: 'tur_0',
        blocks: [
          {
            block_id: 'blk_1_0',
            block_type: 'text',
            body: { kind: 'inline' as const, text: 'hi there', byte_length: 8 },
          },
        ],
      },
    ]
    // Use the production zstd compressor since the CLI command's
    // loadTranscriptFromBundle defaults to the matching decompressor.
    const result = writeSessionBlobPack({ session_id: 'ses_alpha', epoch: 2, messages }, zstdSessionBlobCompressor)
    await mkdir(sessionBlobEpochDir(storeRoot, 2), { recursive: true })
    await writeFile(sessionBlobPackPath(storeRoot, 'ses_alpha', 2), result.pack)

    const r = runCli(['index-v2', 'transcript', '--store', storeRoot, '--session-id', 'ses_alpha'])
    expect(r.status).toBe(0)
    const transcript = JSON.parse(r.stdout) as {
      epoch: number
      path: string
      pack_digest: string
      messages: Array<{ message_id: string; ordinal: number; role: string }>
    }
    expect(transcript.epoch).toBe(2)
    expect(typeof transcript.pack_digest).toBe('string')
    expect(transcript.pack_digest.length).toBeGreaterThan(0)
    expect(transcript.messages.map((m) => m.message_id)).toEqual(['msg_000000', 'msg_000001'])
    expect(transcript.messages.map((m) => m.ordinal)).toEqual([0, 1])
    expect(transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('`index-v2 transcript` fails on an unknown session_id', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli(['index-v2', 'transcript', '--store', storeRoot, '--session-id', 'ses_missing'])
    expect(r.status).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it('`index-v2 transcript` fails when --session-id is missing', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'prosa-cli-index-v2-'))
    const r = runCli(['index-v2', 'transcript', '--store', storeRoot])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/required option.*--session-id/i)
  })
})
