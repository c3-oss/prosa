import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { BundleLockedError, acquireLock, writeStaleLock } from '../../src/bundle/lock.js'

async function tmpDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'prosa-bundle-v2-lock-'))
}

describe('prosa.lock advisory lock', () => {
  it('creates the lock file with the current PID and releases it', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'prosa.lock')
    const lock = await acquireLock(path)
    expect(lock.pid).toBe(process.pid)
    expect((await readFile(path, 'utf8')).trim()).toBe(String(process.pid))
    await lock.release()
  })

  it('blocks a second concurrent acquirer with BundleLockedError', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'prosa.lock')
    const a = await acquireLock(path)
    await expect(acquireLock(path)).rejects.toBeInstanceOf(BundleLockedError)
    await a.release()
  })

  it('adopts a stale lock when the recorded PID is not alive', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'prosa.lock')
    // Use PID 0 which `process.kill(0, 0)` treats as the current process
    // signal target; instead use a deliberately invalid PID. Use a very
    // high number that almost certainly does not exist.
    await writeStaleLock(path, 999999)
    const lock = await acquireLock(path)
    expect(lock.pid).toBe(process.pid)
    await lock.release()
  })

  it('release() is a no-op if the lock file already disappeared', async () => {
    const dir = await tmpDir()
    const path = join(dir, 'prosa.lock')
    const lock = await acquireLock(path)
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    await lock.release() // should not throw
  })
})
