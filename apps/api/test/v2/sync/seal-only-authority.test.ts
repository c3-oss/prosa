// Lane 5 completion gate L5.7 — only the seal implementation may
// write to the v2 authority tables:
//
//   - remote_authority_v2
//   - search_generation_current
//   - receipt_pack_grant
//
// This is a security invariant: any code path that inserts/updates
// those tables bypasses the SealPromotion transaction (which is the
// only place that builds + signs the receipt) and can produce
// authority rows the receipt cannot back. We pin it as a
// source-grep that walks `apps/api/src/` and asserts the only
// mutating SQL is in `seal-promotion.ts`.
//
// Read-only references (SELECT/FROM in BeginPromotion authority
// validation, schema bootstrap blocks, code comments, error
// messages) are explicitly allowed — the grep matches mutating
// verbs only.

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(moduleDir, '../../../src')

const AUTHORITY_TABLES = ['remote_authority_v2', 'search_generation_current', 'receipt_pack_grant'] as const

// Match `INSERT INTO <table>`, `UPDATE <table>`, and PostgreSQL
// upsert variants. Case-insensitive. Whitespace between the verb
// and the table name is required.
function mutatingPatternFor(table: string): RegExp {
  return new RegExp(`(?:INSERT\\s+INTO|UPDATE|UPSERT\\s+INTO)\\s+${table}\\b`, 'i')
}

async function walkSrc(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry)
    const st = await stat(full)
    if (st.isDirectory()) {
      await walkSrc(full, out)
    } else if (full.endsWith('.ts')) {
      out.push(full)
    }
  }
}

describe('Lane 5 gate L5.7: only seal-promotion writes to authority tables', () => {
  for (const table of AUTHORITY_TABLES) {
    it(`only apps/api/src/v2/sync/seal-promotion.ts mutates ${table}`, async () => {
      const files: string[] = []
      await walkSrc(srcRoot, files)
      const pattern = mutatingPatternFor(table)
      const violators: Array<{ file: string; snippet: string }> = []
      for (const file of files) {
        const rel = path.relative(srcRoot, file)
        if (rel === path.join('v2', 'sync', 'seal-promotion.ts')) continue
        const text = await readFile(file, 'utf8')
        const match = pattern.exec(text)
        if (match !== null) {
          // Capture a short window around the match for the
          // failure message.
          const start = Math.max(0, match.index - 40)
          const end = Math.min(text.length, match.index + match[0].length + 80)
          violators.push({ file: rel, snippet: text.slice(start, end).replace(/\s+/g, ' ').trim() })
        }
      }
      if (violators.length > 0) {
        const detail = violators.map((v) => `  - ${v.file}: …${v.snippet}…`).join('\n')
        throw new Error(
          `Authority table ${table} must only be written from seal-promotion.ts (Lane 5 invariant L5.7). Found:\n${detail}`,
        )
      }
      expect(violators).toEqual([])
    })
  }

  it('seal-promotion.ts mutates each of the three authority tables (positive control)', async () => {
    const sealText = await readFile(path.join(srcRoot, 'v2', 'sync', 'seal-promotion.ts'), 'utf8')
    for (const table of AUTHORITY_TABLES) {
      expect(mutatingPatternFor(table).test(sealText), `seal-promotion.ts should INSERT/UPDATE ${table}`).toBe(true)
    }
  })
})
