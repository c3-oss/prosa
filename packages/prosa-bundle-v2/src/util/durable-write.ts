// Durable file write helper: open + write + fsync + close (CQ-034).
//
// `fs.writeFile` does NOT call fsync — the bytes can sit in the kernel
// page cache and disappear in a crash. Every pack/segment/manifest write
// goes through this helper so the bytes are durable on disk before the
// caller observes the write as complete.

import { mkdir, open, opendir } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeFileDurable(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Best-effort directory fsync. Returns silently when the platform does
 * not support fsync on directories (macOS/APFS).
 */
export async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await opendir(dir)
    const inner = await open(dir, 'r')
    try {
      await inner.sync()
    } finally {
      await inner.close()
    }
    await handle.close()
  } catch {
    // best effort — some platforms reject opening a directory r/w
  }
}
