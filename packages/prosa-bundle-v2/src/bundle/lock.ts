// `prosa.lock` advisory lock for bundle v2.
//
// The lock file is created atomically with `wx` flag on open. It stores the
// owning process's PID. On open, if the file exists we read the PID; if the
// process is alive we throw `BundleLockedError`; if it is gone (stale lock)
// we adopt the lock.

import { open, readFile, rm, writeFile } from 'node:fs/promises'

export class BundleLockedError extends Error {
  override name = 'BundleLockedError'
  constructor(
    public readonly path: string,
    public readonly ownerPid: number,
  ) {
    super(`bundle is locked by pid ${ownerPid} at ${path}`)
  }
}

export type LockHandle = {
  path: string
  pid: number
  release(): Promise<void>
}

async function isProcessAlive(pid: number): Promise<boolean> {
  if (pid <= 0 || !Number.isInteger(pid)) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      // Process exists but we cannot signal it.
      return true
    }
    return false
  }
}

async function tryCreateLock(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'wx')
    await handle.writeFile(String(process.pid))
    await handle.sync()
    await handle.close()
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * Acquire `prosa.lock`. Stale locks (PID not alive) are adopted. Returns a
 * `LockHandle` whose `release()` deletes the lock file.
 */
export async function acquireLock(path: string): Promise<LockHandle> {
  if (await tryCreateLock(path)) {
    return { path, pid: process.pid, release: () => releaseLock(path) }
  }
  // Existing lock — read PID and decide.
  let pid: number
  try {
    const raw = await readFile(path, 'utf8')
    pid = Number.parseInt(raw.trim(), 10)
  } catch {
    pid = -1
  }
  if (await isProcessAlive(pid)) {
    throw new BundleLockedError(path, pid)
  }
  // Stale lock: rewrite atomically by deleting then re-creating.
  await rm(path, { force: true })
  if (await tryCreateLock(path)) {
    return { path, pid: process.pid, release: () => releaseLock(path) }
  }
  // Race lost between rm and create — fall through.
  throw new BundleLockedError(path, pid)
}

async function releaseLock(path: string): Promise<void> {
  // Best-effort: only delete if the file still names our PID.
  try {
    const raw = await readFile(path, 'utf8')
    if (Number.parseInt(raw.trim(), 10) === process.pid) {
      await rm(path, { force: true })
    }
  } catch {
    // ignore — already gone
  }
}

// Exported helper for tests that need to inject a stale lock.
export async function writeStaleLock(path: string, pid: number): Promise<void> {
  await writeFile(path, String(pid))
}
