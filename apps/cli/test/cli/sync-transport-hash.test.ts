import { putBytes } from '@c3-oss/prosa-core'
import { describe, expect, it } from 'vitest'
import { readBundleForUpload } from '../../src/cli/sync/bundle.js'
import { createTempBundle } from '../helpers/tmp-bundle.js'

describe('CLI sync CAS transport hashes', () => {
  it('uses catalog transport_hash without reading compressed CAS bytes during planning', async () => {
    const t = await createTempBundle()
    try {
      const objectId = await putBytes(t.bundle, Buffer.from('sync transport '.repeat(1_000), 'utf8'))
      const row = t.bundle.db
        .prepare<[string], { compression: string; transport_hash: string | null }>(
          `SELECT compression, transport_hash FROM objects WHERE object_id = ?`,
        )
        .get(objectId)
      expect(row?.compression).toBe('zstd')
      expect(row?.transport_hash).toMatch(/^[0-9a-f]{64}$/)

      const upload = await readBundleForUpload(t.bundle, t.path)

      expect(upload.casObjects).toHaveLength(1)
      expect(upload.casObjects[0]?.entry.transportHash).toBe(row?.transport_hash)
      expect(upload.casObjects[0]?.bytes).toBeUndefined()
      expect(upload.metrics.localObjectsRead).toBe(0)
      expect(upload.metrics.localBytesRead).toBe(0)
    } finally {
      await t.cleanup()
    }
  })

  it('lazily backfills legacy compressed object rows', async () => {
    const t = await createTempBundle()
    try {
      const objectId = await putBytes(t.bundle, Buffer.from('legacy transport '.repeat(1_000), 'utf8'))
      t.bundle.db.prepare(`UPDATE objects SET transport_hash = NULL WHERE object_id = ?`).run(objectId)

      const upload = await readBundleForUpload(t.bundle, t.path)
      const backfilled = t.bundle.db
        .prepare<[string], { transport_hash: string | null }>(`SELECT transport_hash FROM objects WHERE object_id = ?`)
        .get(objectId)

      expect(upload.casObjects).toHaveLength(1)
      expect(upload.metrics.localObjectsRead).toBe(1)
      expect(upload.metrics.localBytesRead).toBeGreaterThan(0)
      expect(upload.casObjects[0]?.bytes).toBeInstanceOf(Uint8Array)
      expect(backfilled?.transport_hash).toBe(upload.casObjects[0]?.entry.transportHash)
    } finally {
      await t.cleanup()
    }
  })
})
