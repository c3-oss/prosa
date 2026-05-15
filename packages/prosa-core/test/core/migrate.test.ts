import { describe, expect, it } from 'vitest'
import { currentSchemaVersion, runMigrations } from '../../src/core/schema/migrate.js'
import { PROSA_SCHEMA_VERSION } from '../../src/core/version.js'
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js'

describe('migrations', () => {
  it('runs all migrations on init and reports the current version', async () => {
    const t = await createTempBundle()
    try {
      expect(currentSchemaVersion(t.bundle.db)).toBe(PROSA_SCHEMA_VERSION)
      expect(
        queryCount(t.bundle.db, `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'`),
      ).toBe(1)
    } finally {
      await t.cleanup()
    }
  })

  it('is idempotent — re-running runMigrations is a no-op', async () => {
    const t = await createTempBundle()
    try {
      const result = runMigrations(t.bundle.db)
      expect(result.applied).toEqual([])
    } finally {
      await t.cleanup()
    }
  })
})
