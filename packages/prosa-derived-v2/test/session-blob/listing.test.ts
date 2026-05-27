// SessionBlobPackV2 directory-listing tests.
//
// Covers `listSessionBlobEpochs(bundleRoot)` and
// `listSessionBlobSessions({ bundleRoot, epoch })`: deterministic
// sorted output, ENOENT-tolerance, per-entry name filtering, symlink
// dropping under managed directories, CQ-098 intermediate-symlink
// rejection at `derived` / `derived/session-blob` / `epoch-<n>`,
// bundle-root-alias acceptance, and synchronous input validation.

import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../../src/derived-layout.js'
import {
  listAllSessionBlobSessions,
  listSessionBlobEpochs,
  listSessionBlobSessions,
} from '../../src/session-blob/listing.js'

describe('listSessionBlobEpochs', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-list-epochs-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] on a fresh bundle (ENOENT-tolerant)', async () => {
    expect(await listSessionBlobEpochs(bundleRoot)).toEqual([])
  })

  it('enumerates epoch-<n> directories sorted ascending, deduplicated', async () => {
    for (const n of [5, 0, 12, 2]) {
      await mkdir(sessionBlobEpochDir(bundleRoot, n), { recursive: true })
    }
    expect(await listSessionBlobEpochs(bundleRoot)).toEqual([0, 2, 5, 12])
  })

  it('ignores entries that do not match the `epoch-<n>` pattern', async () => {
    const parent = join(bundleRoot, 'derived', 'session-blob')
    await mkdir(parent, { recursive: true })
    await mkdir(join(parent, 'epoch-3'), { recursive: true })
    // Non-conformant siblings: leading zero, non-integer suffix,
    // missing suffix, alpha suffix, regular file.
    await mkdir(join(parent, 'epoch-01'), { recursive: true })
    await mkdir(join(parent, 'epoch-3.5'), { recursive: true })
    await mkdir(join(parent, 'epoch-'), { recursive: true })
    await mkdir(join(parent, 'epoch-abc'), { recursive: true })
    await writeFile(join(parent, 'epoch-7'), 'this is a file, not a dir')

    expect(await listSessionBlobEpochs(bundleRoot)).toEqual([3])
  })

  it('drops symlinked entries under `derived/session-blob/` (per-entry rejection)', async () => {
    const parent = join(bundleRoot, 'derived', 'session-blob')
    await mkdir(parent, { recursive: true })
    await mkdir(join(parent, 'epoch-1'), { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-epochs-ext-'))
    try {
      await symlink(external, join(parent, 'epoch-9'))
      // Even though `epoch-9` would parse as a valid epoch number,
      // the symlink is dropped at the entry filter.
      expect(await listSessionBlobEpochs(bundleRoot)).toEqual([1])
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: throws when `derived/session-blob` is a symlink (parent containment)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-epochs-cq098-'))
    try {
      await mkdir(join(external, 'epoch-2'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(listSessionBlobEpochs(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: throws when `derived` is a symlink (outermost containment)', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-epochs-derived-'))
    try {
      await mkdir(join(external, 'session-blob', 'epoch-3'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived'))

      await expect(listSessionBlobEpochs(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 4), { recursive: true })
    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-list-epochs-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await listSessionBlobEpochs(aliasRoot)).toEqual([4])
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })
})

describe('listSessionBlobSessions', () => {
  let bundleRoot: string
  const EPOCH = 5

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-list-sessions-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] on a fresh bundle (ENOENT)', async () => {
    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual([])
  })

  it('returns [] when the epoch dir exists but is empty', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, EPOCH), { recursive: true })
    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual([])
  })

  it('enumerates `<session_id>.pack` regular files sorted ascending, deduplicated', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    for (const id of ['ses_zeta', 'ses_alpha', 'ses_mike', 'prosa.session.v2:claude:abc']) {
      await writeFile(join(dir, `${id}.pack`), 'fake pack bytes')
    }
    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual([
      'prosa.session.v2:claude:abc',
      'ses_alpha',
      'ses_mike',
      'ses_zeta',
    ])
  })

  it('ignores non-`.pack` files and subdirectories', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_good.pack'), 'fake')
    await writeFile(join(dir, 'README.md'), 'docs')
    await writeFile(join(dir, 'ses_extra.json'), '{}')
    await mkdir(join(dir, 'subdir'), { recursive: true })
    // A `.pack` named subdirectory must not surface as a session: it
    // is a directory, not a file, so the `Dirent.isFile()` filter
    // drops it.
    await mkdir(join(dir, 'ses_dir.pack'), { recursive: true })

    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual(['ses_good'])
  })

  it('drops symlinked `.pack` entries (per-entry rejection)', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_real.pack'), 'fake')
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-sessions-ext-'))
    try {
      await writeFile(join(external, 'external.pack'), 'fake')
      await symlink(join(external, 'external.pack'), join(dir, 'ses_linked.pack'))
      expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual(['ses_real'])
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('rejects pack filenames whose session-id part contains `..`', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_good.pack'), 'fake')
    // `ses_..escape.pack` is a valid filename on disk; the listing
    // must drop it because the session-id grammar in
    // `sessionBlobPackPath` rejects `..` substrings. The listing
    // would otherwise surface ids that no caller could feed back in.
    await writeFile(join(dir, 'ses_..escape.pack'), 'fake')

    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual(['ses_good'])
  })

  it('CQ-099: rejects a literal `.pack` filename (session-id `.` is reserved)', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_good.pack'), 'fake')
    // `.pack` matches `<session_id>.pack` with `session_id="."`.
    // `sessionBlobPackPath(bundleRoot, '.', epoch)` rejects `.` as a
    // current-directory vector, so the listing must drop the entry
    // — list-then-load workflows would otherwise fail at the resolver.
    await writeFile(join(dir, '.pack'), 'fake')
    // `..pack` matches with `session_id=".."`. The same rejection
    // applies (literal `..` is reserved).
    await writeFile(join(dir, '..pack'), 'fake')

    expect(await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).toEqual(['ses_good'])
  })

  it('CQ-099: every returned id round-trips through sessionBlobPackPath without throwing', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    // Mix valid + invalid filenames; the listing must drop every
    // invalid one and every returned id must satisfy the resolver.
    for (const name of ['ses_alpha.pack', '.pack', '..pack', 'ses_..bad.pack', 'prosa.session.v2:claude:zzz.pack']) {
      await writeFile(join(dir, name), 'fake')
    }
    const listed = await listSessionBlobSessions({ bundleRoot, epoch: EPOCH })
    // Every id must round-trip through the resolver without throwing.
    for (const id of listed) {
      expect(() => sessionBlobPackPath(bundleRoot, id, EPOCH)).not.toThrow()
    }
    expect(listed).toEqual(['prosa.session.v2:claude:zzz', 'ses_alpha'])
  })

  it('CQ-098: throws when `epoch-<n>` itself is a symlink (per-epoch containment)', async () => {
    await mkdir(join(bundleRoot, 'derived', 'session-blob'), { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-sessions-cq098-epoch-'))
    try {
      await writeFile(join(external, 'ses_external.pack'), 'fake')
      await symlink(external, sessionBlobEpochDir(bundleRoot, EPOCH))

      await expect(listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('CQ-098: throws when `derived/session-blob` is a symlink', async () => {
    await mkdir(join(bundleRoot, 'derived'), { recursive: true })
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-sessions-cq098-sb-'))
    try {
      const externalEpochDir = join(external, `epoch-${EPOCH}`)
      await mkdir(externalEpochDir, { recursive: true })
      await writeFile(join(externalEpochDir, 'ses_external.pack'), 'fake')
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(listSessionBlobSessions({ bundleRoot, epoch: EPOCH })).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, EPOCH)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_real.pack'), 'fake')

    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-list-sessions-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await listSessionBlobSessions({ bundleRoot: aliasRoot, epoch: EPOCH })).toEqual(['ses_real'])
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('rejects a negative epoch synchronously (input validation delegation)', async () => {
    await expect(listSessionBlobSessions({ bundleRoot, epoch: -1 })).rejects.toThrow(/non-negative safe integer/)
  })
})

describe('listAllSessionBlobSessions', () => {
  let bundleRoot: string

  beforeEach(async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'prosa-derived-list-all-'))
  })

  afterEach(async () => {
    await rm(bundleRoot, { recursive: true, force: true })
  })

  it('returns [] on a fresh bundle (no epochs)', async () => {
    expect(await listAllSessionBlobSessions(bundleRoot)).toEqual([])
  })

  it('returns [] when epochs exist but every epoch directory is empty', async () => {
    await mkdir(sessionBlobEpochDir(bundleRoot, 0), { recursive: true })
    await mkdir(sessionBlobEpochDir(bundleRoot, 3), { recursive: true })
    expect(await listAllSessionBlobSessions(bundleRoot)).toEqual([])
  })

  it('returns the deduplicated sorted union across every epoch', async () => {
    // Epoch 1: alpha, bravo
    // Epoch 3: bravo, charlie
    // Epoch 7: alpha, delta
    // Expected union: [alpha, bravo, charlie, delta] (each once, sorted)
    for (const [epoch, ids] of [
      [1, ['ses_alpha', 'ses_bravo']],
      [3, ['ses_bravo', 'ses_charlie']],
      [7, ['ses_alpha', 'ses_delta']],
    ] as const) {
      const dir = sessionBlobEpochDir(bundleRoot, epoch)
      await mkdir(dir, { recursive: true })
      for (const id of ids) await writeFile(join(dir, `${id}.pack`), 'fake')
    }

    expect(await listAllSessionBlobSessions(bundleRoot)).toEqual(['ses_alpha', 'ses_bravo', 'ses_charlie', 'ses_delta'])
  })

  it('mixes epochs containing valid packs with epochs containing only invalid filenames', async () => {
    // Epoch 1: only invalid files (no ids in result)
    // Epoch 2: real session
    const dir1 = sessionBlobEpochDir(bundleRoot, 1)
    await mkdir(dir1, { recursive: true })
    await writeFile(join(dir1, '.pack'), 'fake') // CQ-099: dropped
    await writeFile(join(dir1, 'README.md'), 'docs') // non-`.pack`: dropped
    const dir2 = sessionBlobEpochDir(bundleRoot, 2)
    await mkdir(dir2, { recursive: true })
    await writeFile(join(dir2, 'ses_real.pack'), 'fake')

    expect(await listAllSessionBlobSessions(bundleRoot)).toEqual(['ses_real'])
  })

  it('silently drops a symlinked `epoch-<n>` entry (per-entry symlink filter inherited from listSessionBlobEpochs)', async () => {
    // A symlinked epoch directory under `derived/session-blob/`
    // never appears in `listSessionBlobEpochs`'s output (per-entry
    // `Dirent.isSymbolicLink()` filter), so the union iterator
    // never asks for the symlinked epoch's sessions. The real
    // epoch survives. Security boundary is preserved elsewhere:
    // any caller that explicitly invokes
    // `loadSessionBlobPack({ epoch: <symlinked> })` still hits the
    // CQ-098 intermediate-symlink throw via the loader.
    const dir1 = sessionBlobEpochDir(bundleRoot, 1)
    await mkdir(dir1, { recursive: true })
    await writeFile(join(dir1, 'ses_real.pack'), 'fake')
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-all-cq098-'))
    try {
      await writeFile(join(external, 'ses_external.pack'), 'fake')
      await symlink(external, sessionBlobEpochDir(bundleRoot, 3))

      expect(await listAllSessionBlobSessions(bundleRoot)).toEqual(['ses_real'])
      // External target survives unchanged.
      const linkStat = await lstat(sessionBlobEpochDir(bundleRoot, 3))
      expect(linkStat.isSymbolicLink()).toBe(true)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('propagates parent CQ-098 rejection when `derived/session-blob` itself is a symlink', async () => {
    const external = await mkdtemp(join(tmpdir(), 'prosa-derived-list-all-parent-'))
    try {
      await mkdir(join(external, 'epoch-1'), { recursive: true })
      await mkdir(join(bundleRoot, 'derived'), { recursive: true })
      await symlink(external, join(bundleRoot, 'derived', 'session-blob'))

      await expect(listAllSessionBlobSessions(bundleRoot)).rejects.toThrow(/CQ-098|intermediate/i)
    } finally {
      await rm(external, { recursive: true, force: true })
    }
  })

  it('accepts a symlinked bundle-root alias when the SessionBlob tree is real', async () => {
    const dir = sessionBlobEpochDir(bundleRoot, 5)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'ses_aliased.pack'), 'fake')

    const aliasParent = await mkdtemp(join(tmpdir(), 'prosa-derived-list-all-alias-'))
    try {
      const aliasRoot = join(aliasParent, 'bundle-alias')
      await symlink(bundleRoot, aliasRoot)
      expect(await listAllSessionBlobSessions(aliasRoot)).toEqual(['ses_aliased'])
    } finally {
      await rm(aliasParent, { recursive: true, force: true })
    }
  })

  it('result is suitable for round-trip through sessionBlobPackPath (CQ-099 inherited)', async () => {
    // Mix valid + invalid filenames across multiple epochs; the
    // union must still pass the resolver invariant.
    const dir1 = sessionBlobEpochDir(bundleRoot, 1)
    await mkdir(dir1, { recursive: true })
    await writeFile(join(dir1, 'ses_alpha.pack'), 'fake')
    await writeFile(join(dir1, '.pack'), 'fake')
    const dir2 = sessionBlobEpochDir(bundleRoot, 2)
    await mkdir(dir2, { recursive: true })
    await writeFile(join(dir2, 'ses_bravo.pack'), 'fake')
    await writeFile(join(dir2, '..pack'), 'fake')

    const all = await listAllSessionBlobSessions(bundleRoot)
    expect(all).toEqual(['ses_alpha', 'ses_bravo'])
    for (const id of all) {
      expect(() => sessionBlobPackPath(bundleRoot, id, 0)).not.toThrow()
    }
  })
})
