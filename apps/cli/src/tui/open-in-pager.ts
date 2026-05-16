import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type Bundle, getText } from '@c3-oss/prosa-core'

/**
 * Fetch a CAS-backed blob and hand it off to `$PAGER` (default `less -R`).
 *
 * The TUI runs Ink in raw mode, so we rely on `stdio: 'inherit'` to let the
 * pager seize the terminal for its lifetime. Ink restores its frame on the
 * next render after the pager exits.
 */
export async function openInPager(bundle: Bundle, objectId: string): Promise<void> {
  let text: string
  try {
    text = await getText(bundle, objectId)
  } catch (err) {
    throw new Error(`content unavailable: ${objectId} (${(err as Error).message})`)
  }

  const file = path.join(os.tmpdir(), `prosa-output-${randomBytes(8).toString('hex')}.txt`)
  await writeFile(file, text, 'utf8')

  const pager = process.env.PAGER || 'less'
  // `less -R` keeps ANSI escapes intact so future colored payloads still
  // render. Anything else is invoked with no extra args.
  const args = pager === 'less' ? ['-R', file] : [file]
  const result = spawnSync(pager, args, { stdio: 'inherit' })
  if (result.error) {
    throw new Error(`failed to launch pager '${pager}': ${result.error.message}`)
  }
}
