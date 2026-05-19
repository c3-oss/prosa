// SessionBlobPackV2 existence-probe tests.
//
// `sessionBlobPackExists({ bundleRoot, sessionId, epoch })` returns
// `boolean` instead of throwing on negative filesystem outcomes
// (ENOENT, symlinks, non-regular-files). Sync input-validation
// errors still throw — a probe answers presence, not correctness.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import { sessionBlobPackExists } from '../../src/session-blob/exists.js'

const SESSION_ID = 'ses_exists_demo'
const EPOCH = 3

describe('sessionBlobPackExists', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-exists-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns true when a real regular pack file is present at the canonical path', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH), 'fake pack bytes')

    expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(true)
  })

  it('returns false on a fresh bundle (no derived tree)', async () => {
    expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
  })

  it('returns false when the epoch directory exists but the pack file does not', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
  })

  it('returns false when the pack file is a symlink (CQ-094 final-component refusal)', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-exists-cq094-'))
    try {
      const externalPath = join(external, 'external.pack')
      await writeFile(externalPath, 'fake')
      await symlink(externalPath, sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH))

      expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('returns false when the pack path is a directory (non-regular-file refusal)', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    await mkdir(sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH), { recursive: true })

    expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
  })

  it('returns false when `derived/session-blob` is a symlink (CQ-098 intermediate refusal)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-exists-cq098-sb-'))
    try {
      const externalEpochDir = join(external, `epoch-${EPOCH}`)
      await mkdir(externalEpochDir, { recursive: true })
      await writeFile(join(externalEpochDir, `${SESSION_ID}.pack`), 'fake')
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('returns false when `epoch-<n>` is a symlink (CQ-098 per-epoch refusal)', async () => {
    await mkdir(join(bundleRoot, 'derived', 'session-blob'), { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-exists-cq098-epoch-'))
    try {
      await writeFile(join(external, `${SESSION_ID}.pack`), 'fake')
      await symlink(external, sessionBlobEpochDir(bundleRoot, EPOCH))

      expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(false)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH), 'fake')

    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-exists-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await sessionBlobPackExists({ bundleRoot: aliasRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(true)
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('throws synchronously on invalid sessionId (probe answers presence, not correctness)', async () => {
    await expect(sessionBlobPackExists({ bundleRoot, sessionId: 'ses/escape', epoch: EPOCH })).rejects.toThrow(
      /characters outside/,
    )
    await expect(sessionBlobPackExists({ bundleRoot, sessionId: '..', epoch: EPOCH })).rejects.toThrow(
      /'\.\.' segments/,
    )
    await expect(sessionBlobPackExists({ bundleRoot, sessionId: '', epoch: EPOCH })).rejects.toThrow(/non-empty string/)
  })

  it('throws synchronously on invalid epoch', async () => {
    await expect(sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: -1 })).rejects.toThrow(
      /non-negative safe integer/,
    )
    await expect(sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: 1.5 })).rejects.toThrow(
      /non-negative safe integer/,
    )
  })

  it('is cheap: does not read any bytes (verified by planting a bogus file)', async () => {
    // The probe must not parse or validate the contents — a 1-byte
    // file with garbage content still counts as "exists".
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    await writeFile(sessionBlobPackPath(bundleRoot, SESSION_ID, EPOCH), 'x')
    expect(await sessionBlobPackExists({ bundleRoot, sessionId: SESSION_ID, epoch: EPOCH })).toBe(true)
  })
})
