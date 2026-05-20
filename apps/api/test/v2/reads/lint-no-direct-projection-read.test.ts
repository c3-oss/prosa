// Lane 6 — lint check: every read handler must compose
// `verifiedProjectionWhere` when touching a projection / search table.
//
// The check grep-walks every TypeScript file under
// `apps/api/src/v2/reads/` (excluding the gate helper itself). If a
// file mentions any `VERIFIED_PROJECTION_TABLES` entry in raw SQL it
// must also reference `verifiedProjectionWhere`. A new handler that
// bypasses the gate fails this test even before the focused route
// test catches it.
//
// CQ-141 follow-up note: this is a stronger lint than the v1 gate
// because the v2 gate fragment is the ONLY join that proves
// receipt-pinning. A read path that opens the projection table
// without it leaks superseded rows to the client.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERIFIED_PROJECTION_TABLES } from '../../../src/v2/reads/shared/verified-projection.js'

const READS_DIR = join(import.meta.dirname, '..', '..', '..', 'src', 'v2', 'reads')
const GATE_HELPER_RELATIVE = join('shared', 'verified-projection.ts')

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('Lane 6 read paths cannot bypass the verified-projection gate', () => {
  it('every file under src/v2/reads/ that mentions a projection table also references verifiedProjectionWhere', async () => {
    const files = await walk(READS_DIR)
    const offenders: Array<{ file: string; table: string }> = []
    for (const file of files) {
      if (file.endsWith(GATE_HELPER_RELATIVE)) continue
      // The shared cursor / cache utilities should not need the gate.
      if (file.endsWith(join('shared', 'cursor.ts'))) continue
      if (file.endsWith('authority-cache.ts')) continue
      if (file.endsWith('authority.ts')) continue
      if (file.endsWith('index.ts')) continue
      const text = await fs.readFile(file, 'utf8')
      const mentions = VERIFIED_PROJECTION_TABLES.filter((t) => text.includes(t))
      if (mentions.length === 0) continue
      // The gate is applied directly (`verifiedProjectionWhere`,
      // `verifiedSearchWhere`) or indirectly through a helper that
      // composes it (`buildSessionWhere` from `sessions/filters.ts`).
      // Adding a new gate-aware helper means updating this allowlist
      // and the helper itself.
      const composesGate =
        text.includes('verifiedProjectionWhere') ||
        text.includes('verifiedSearchWhere') ||
        text.includes('buildSessionWhere')
      if (!composesGate) {
        for (const m of mentions) offenders.push({ file, table: m })
      }
    }
    expect(offenders).toEqual([])
  })
})
