// SessionBlobPackV2 on-disk loader tests.
//
// `loadSessionBlobPack({ bundleRoot, sessionId, epoch })` resolves the
// canonical pack path, reads the bytes, re-verifies the pack digest,
// and returns the decoded header + per-page slices. The tests cover
// the happy round-trip (write to disk, load, verify everything
// matches), filesystem hardening (symlink rejection at the pack path,
// non-regular-file rejection), tamper detection (corrupted bytes),
// missing file (ENOENT), and input-validation delegation.

import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { loadSessionBlobPack } from '../../src/session-blob/loader.js'
import { identityCompressor } from '../../src/session-blob/reader.js'
import { type BlobMessageInput, writeSessionBlobPack } from '../../src/session-blob/writer.js'

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

const SESSION_ID = 'ses_loader_demo'
const EPOCH = 3

async function writePackToDisk(bundleRoot: string, messages: BlobMessageInput[]) {
  const result = writeSessionBlobPack({ session_id: SESSION_ID, epoch: EPOCH, messages }, identityCompressor)
  const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
  await mkdir(dir, { recursive: true })
  const path = sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH)
  await writeFile(path, result.pack)
  return { path, expected: result }
}

describe('loadSessionBlobPack', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('round-trips a written pack: returns header, pageBytes, path, bytes, and recomputed pack_digest', async () => {
    const messages = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hello')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'world')]),
    ]
    const { path, expected } = await writePackToDisk(bundleRoot, messages)

    const loaded = await loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })

    expect(loaded.path).toBe(path)
    expect(loaded.pack_digest).toBe(expected.pack_digest)
    expect(loaded.header.pack_digest).toBe(expected.pack_digest)
    expect(loaded.header.epoch).toBe(EPOCH)
    expect(loaded.header.compression).toBe('zstd')
    expect(loaded.header.page_count).toBe(expected.header.page_count)
    expect(loaded.pageBytes.length).toBe(expected.header.page_count)
    expect(Array.from(loaded.bytes)).toEqual(Array.from(expected.pack))
  })

  it('propagates ENOENT when the pack does not exist (callers distinguish missing from corrupt)', async () => {
    await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('rejects when the pack path is a symlink (CQ-094 final-component hardening)', async () => {
    // Plant an external pack so the symlink target would otherwise
    // decode successfully. The loader must refuse before following.
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'hi')])]
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-ext-'))
    try {
      const result = writeSessionBlobPack({ session_id: SESSION_ID, epoch: EPOCH, messages }, identityCompressor)
      const externalPath = join(external, 'external.pack')
      await writeFile(externalPath, result.pack)
      const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
      await mkdir(dir, { recursive: true })
      const packPath = sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH)
      await symlink(externalPath, packPath)

      await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
        /symlink|CQ-094/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: refuses when `derived/session-blob` is a symlink to an external dir with a valid pack', async () => {
    // Plant a real external pack so `lstat(packPath)` would see a
    // valid file without the intermediate-symlink check. The loader
    // must reject before the outer `lstat` walks through the symlink.
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'external')])]
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-cq098-sb-'))
    try {
      const result = writeSessionBlobPack({ session_id: SESSION_ID, epoch: EPOCH, messages }, identityCompressor)
      const externalEpochDir = join(external, `epoch-${EPOCH}`)
      await mkdir(externalEpochDir, { recursive: true })
      await writeFile(join(externalEpochDir, `${SESSION_ID}.pack`), result.pack)
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
      // External pack survives unchanged.
      const linkStat = await lstat(join(bundleRoot, 'derived', 'session-blob'))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: refuses when `derived/session-blob/epoch-<n>` is a symlink to an external dir with a valid pack', async () => {
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'external')])]
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-cq098-epoch-'))
    try {
      const result = writeSessionBlobPack({ session_id: SESSION_ID, epoch: EPOCH, messages }, identityCompressor)
      await writeFile(join(external, `${SESSION_ID}.pack`), result.pack)
      await mkdir(join(bundleRoot, 'derived', 'session-blob'), { recursive: true })
      await symlink(external, sessionBlobEpochDir(bundleRoot, EPOCH))

      await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
      const linkStat = await lstat(sessionBlobEpochDir(bundleRoot, EPOCH))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: refuses when `derived` is a symlink to an external tree (outermost)', async () => {
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'external')])]
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-cq098-derived-'))
    try {
      const result = writeSessionBlobPack({ session_id: SESSION_ID, epoch: EPOCH, messages }, identityCompressor)
      const externalEpochDir = join(external, 'session-blob', `epoch-${EPOCH}`)
      await mkdir(externalEpochDir, { recursive: true })
      await writeFile(join(externalEpochDir, `${SESSION_ID}.pack`), result.pack)
      await symlink(external, join(bundleRoot, 'derived'))

      await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
        /CQ-098|intermediate/i,
      )
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: succeeds when the bundle root itself is a symlinked alias and the SessionBlob tree is real', async () => {
    // Bundle-root-alias deployment pattern: operator opens the bundle
    // through a symlinked alias. The containment check targets
    // symlinks *inside* the managed derived tree, not the caller's
    // bundle root.
    const messages = [mkMessage(0, [inlineBlock('blk_0_0', 'text', 'aliased')])]
    await writePackToDisk(bundleRoot, messages)
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-loader-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)

      const loaded = await loadSessionBlobPack({ bundleRoot: aliasRoot, sessionId: SESSION_ID, epoch: EPOCH })

      expect(loaded.header.epoch).toBe(EPOCH)
      expect(loaded.path).toBe(sessionBlobPackPath(aliasRoot, SESSION_ID, EPOCH))
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('rejects when the pack path is a directory (non-regular-file hardening)', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    // Plant a directory where the pack file should be.
    await mkdir(sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH), { recursive: true })

    await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
      /not a regular file/i,
    )
  })

  it('detects tampered pack bytes via pack_digest re-verification', async () => {
    const messages = [
      mkMessage(0, [inlineBlock('blk_0_0', 'text', 'original-bytes-here')]),
      mkMessage(1, [inlineBlock('blk_1_0', 'text', 'more-original-bytes')]),
    ]
    const { path, expected } = await writePackToDisk(bundleRoot, messages)

    // Corrupt a byte deep inside the payload (avoid the framing magic
    // at the start so the framing layer does not catch it first).
    const corrupted = new Uint8Array(expected.pack)
    const tamperOffset = corrupted.length - 8
    corrupted[tamperOffset] = (corrupted[tamperOffset]! + 1) & 0xff
    await writeFile(path, corrupted)

    await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).rejects.toThrow(
      /verifyPackDigest|mismatch|hash|stored_length/i,
    )
  })

  it('delegates sessionId/epoch validation to sessionBlobPackPath (traversal-injection refusal)', async () => {
    // sessionBlobPackPath throws synchronously on a forward-slash; the
    // loader surfaces the error before touching the filesystem.
    await expect(loadSessionBlobPack({ bundleRoot, sessionId: 'ses/escape', epoch: EPOCH })).rejects.toThrow(
      /characters outside/,
    )
    await expect(loadSessionBlobPack({ bundleRoot, sessionId: '..', epoch: EPOCH })).rejects.toThrow(/'\.\.' segments/)
    await expect(loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: -1 })).rejects.toThrow(
      /non-negative safe integer/,
    )
  })

  it('returns pageBytes ready to feed into existing readers (length parity with header.pages)', async () => {
    // Write a multi-message pack so we get at least one populated page.
    const messages = Array.from({ length: 4 }, (_, i) =>
      mkMessage(i, [inlineBlock(`blk_${i}_0`, 'text', `message ${i}`)]),
    )
    await writePackToDisk(bundleRoot, messages)

    const loaded = await loadSessionBlobPack({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })

    expect(loaded.pageBytes.length).toBe(loaded.header.page_count)
    expect(loaded.header.pages.length).toBe(loaded.header.page_count)
    // Each pageBytes slice should have the length declared in the header.
    for (let i = 0; i < loaded.header.page_count; i++) {
      expect(loaded.pageBytes[i]!.length).toBe(loaded.header.pages[i]!.stored_length)
    }
  })
})
