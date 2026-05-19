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
  it('`index-v2 --help` lists status + sessions + epochs + transcript subcommands', async () => {
    const r = runCli(['index-v2', '--help'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Bundle v2 derived-layer index commands')
    expect(r.stdout).toContain('status')
    expect(r.stdout).toContain('sessions')
    expect(r.stdout).toContain('epochs')
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
