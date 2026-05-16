import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSourceFile } from '../../src/core/ingest/idempotency.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

describe('source file idempotency', () => {
  it('persists transport hashes for preserved raw source objects', async () => {
    const t = await createTempBundle()
    try {
      const sourcePath = path.join(t.path, 'source.jsonl')
      await writeFile(sourcePath, '{"type":"message"}\n', 'utf8')

      const result = await registerSourceFile(t.bundle, {
        sourceTool: 'codex',
        absolutePath: sourcePath,
        fileKind: 'jsonl',
      })

      const row = t.bundle.db
        .prepare<[string], { storage_path: string; transport_hash: string | null }>(
          `SELECT storage_path, transport_hash FROM objects WHERE object_id = ?`,
        )
        .get(result.row.object_id ?? '')
      expect(row?.storage_path.startsWith('raw/sources/')).toBe(true)
      expect(row?.transport_hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await t.cleanup()
    }
  })
})
