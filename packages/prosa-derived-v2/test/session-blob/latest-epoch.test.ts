// SessionBlobPackV2 latest-epoch lookup tests.
//
// `latestEpochForSession({ bundleRoot, sessionId })` returns the
// epoch identifier of the newest pack for the session, or `null`
// when no epoch has one. No bytes are read, no digest verified.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { latestEpochForSession } from '../../src/session-blob/latest-epoch.js'

const SESSION_ID = 'ses_latest_epoch_demo'

describe('latestEpochForSession', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-epoch-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  async function plantPack(epoch: number, sessionId: string = SESSION_ID) {
    await mkdir(sessionBlobEpochDir(bundleRoot, epoch), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, sessionId, epoch), 'x')
  }

  it('returns the epoch number when one pack exists', async () => {
    await plantPack(3)
    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(3)
  })

  it('returns the highest epoch when multiple packs exist (newest wins)', async () => {
    await plantPack(1)
    await plantPack(4)
    await plantPack(9)
    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(9)
  })

  it('falls back to the older epoch when newer ones have other sessions but not this one', async () => {
    await plantPack(1)
    await plantPack(3)
    // Epoch 7 exists but for a different session.
    await mkdir(sessionBlobEpochDir(bundleRoot, 7), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other', 7), 'x')

    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(3)
  })

  it('handles holes in the epoch sequence (skips over epochs without this session)', async () => {
    await plantPack(0)
    await plantPack(5)
    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(5)
  })

  it('returns null on a fresh bundle (no epochs)', async () => {
    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBeNull()
  })

  it('returns null when epochs exist but none has a pack for this session', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 1), { recursive: true })
    await mkdir(sessionBlobEpochDir(bundleRoot, 4), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, 'ses_other', 1), 'x')

    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBeNull()
  })

  it('rejects invalid sessionId synchronously (CQ-100 path even on fresh bundle)', async () => {
    await expect(latestEpochForSession({ bundleRoot, sessionId: 'ses/escape' })).rejects.toThrow(/characters outside/)
    await expect(latestEpochForSession({ bundleRoot, sessionId: '..' })).rejects.toThrow(/'\.\.' segments/)
    await expect(latestEpochForSession({ bundleRoot, sessionId: '' })).rejects.toThrow(/non-empty string/)
  })

  it('treats CQ-094 final-component symlinks at a specific epoch as absent (skip and try older)', async () => {
    // Real pack in epoch 1; epoch 5 has a symlinked pack file
    // (CQ-094 → `sessionBlobPackExists` returns false → skipped).
    await plantPack(1)
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-epoch-cq094-'))
    try {
      await writeFile(join(external, 'external.pack'), 'x')
      await mkdir(sessionBlobEpochDir(bundleRoot, 5), { recursive: true })
      await symlink(join(external, 'external.pack'), sessionBlobPackPath(bundleRoot, SESSION_ID, 5))

      // Epoch 5's symlink is rejected by the probe; falls back to 1.
      expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(1)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('propagates CQ-098 intermediate-symlink rejection from the parent listing', async () => {
    // `derived/session-blob` symlinked → `listSessionBlobEpochs`
    // throws synchronously before the per-epoch walk.
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-epoch-cq098-'))
    try {
      await mkdir(join(external, 'epoch-3'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    await plantPack(7)
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-latest-epoch-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await latestEpochForSession({ bundleRoot: aliasRoot, sessionId: SESSION_ID })).toBe(7)
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('does not read pack bytes (succeeds with garbage 1-byte files)', async () => {
    // Plant a 1-byte garbage file in epoch 2. The probe only `lstat`s;
    // contents are not parsed. If the function were trying to read
    // bytes it would fail because the file isn't a valid pack.
    await plantPack(2)
    expect(await latestEpochForSession({ bundleRoot, sessionId: SESSION_ID })).toBe(2)
  })
})
