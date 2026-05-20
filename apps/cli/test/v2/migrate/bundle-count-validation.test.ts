// Lane 9 — count-validation gate.
//
// Injects a fake raw_record into the v1 bundle's SQLite database so
// the v1 count exceeds anything the v2 re-projection can produce.
// The validator must catch the mismatch and the migration must
// abort BEFORE the atomic rename so the v1 bundle stays intact.

import { stat } from 'node:fs/promises'

import { closeBundle, openBundle as openBundleV1 } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'

import { migrateBundle } from '../../../src/cli/v2/migrate/bundle.js'
import { validateMigrationCounts } from '../../../src/cli/v2/migrate/validate.js'
import { buildV1CodexBundle, mktmp } from './helpers.js'

describe('migrateBundle: count validation', () => {
  it('aborts before rename when v1 raw_records count exceeds v2', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})

    // Inject a fake raw_record row referencing a fake import_batch so
    // FK constraints don't kick in. We use a synthetic source_file
    // + import_batch + object so the FK chain holds.
    {
      const v1 = await openBundleV1(oldPath)
      try {
        v1.db
          .prepare(
            `INSERT INTO objects (object_id, hash_alg, hash, size_bytes, compression, storage_path, created_at)
             VALUES ('blake3:deadbeef', 'blake3', 'deadbeef', 1, 'none', 'objects/blake3/de/ad/deadbeef.bin', datetime('now'))`,
          )
          .run()
        v1.db
          .prepare(
            `INSERT INTO source_files (source_file_id, source_tool, path, file_kind, size_bytes, content_hash, discovered_at)
             VALUES ('sf_fake', 'codex', '/tmp/fake', 'session_jsonl', 1, 'deadbeef', datetime('now'))`,
          )
          .run()
        v1.db
          .prepare(
            `INSERT INTO import_batches (batch_id, parser_version, started_at, status)
             VALUES ('batch_fake', '0.0.0', datetime('now'), 'finished')`,
          )
          .run()
        v1.db
          .prepare(
            `INSERT INTO raw_records (raw_record_id, source_file_id, source_tool, record_kind, raw_object_id, parser_status, import_batch_id)
             VALUES ('rr_fake', 'sf_fake', 'codex', 'session_meta', 'blake3:deadbeef', 'ok', 'batch_fake')`,
          )
          .run()
      } finally {
        closeBundle(v1)
      }
    }

    const newPath = await mktmp('prosa-v2-tmp')
    await expect(migrateBundle({ oldPath, newPath })).rejects.toThrow(/count validation failed/i)

    // v1 still at original path.
    const oldStat = await stat(oldPath)
    expect(oldStat.isDirectory()).toBe(true)
  }, 30_000)

  it('validateMigrationCounts reports strict reasons per dimension', async () => {
    const { bundlePath: oldPath } = await buildV1CodexBundle({})
    const v1 = await openBundleV1(oldPath)
    try {
      // Synthetic v2 bundle stub with zero counts.
      const v2Stub = {
        head: {
          counts: {
            sourceFiles: 0,
            rawRecords: 0,
            sessions: 0,
            objects: 0,
            searchDocs: 0,
            turns: 0,
            events: 0,
            messages: 0,
            contentBlocks: 0,
            toolCalls: 0,
            toolResults: 0,
            artifacts: 0,
            edges: 0,
            projectionRows: 0,
          },
        },
      }
      // biome-ignore lint/suspicious/noExplicitAny: synthetic stub
      const validation = await validateMigrationCounts(v1, v2Stub as any)
      expect(validation.ok).toBe(false)
      const reasons = validation.reasons.join(' | ')
      expect(reasons).toMatch(/sourceFiles drift/)
      expect(reasons).toMatch(/sessions drift/)
    } finally {
      closeBundle(v1)
    }
  }, 30_000)
})
