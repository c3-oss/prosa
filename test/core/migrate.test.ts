import { describe, expect, it } from 'vitest';
import { currentSchemaVersion, runMigrations } from '../../src/core/schema/migrate.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

describe('migrations', () => {
  it('runs all migrations on init and reports the current version', async () => {
    const t = await createTempBundle();
    try {
      expect(currentSchemaVersion(t.bundle.db)).toBe(1);
      const tableCount = t.bundle.db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='sessions'`,
        )
        .get();
      expect(tableCount?.n).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('is idempotent — re-running runMigrations is a no-op', async () => {
    const t = await createTempBundle();
    try {
      const result = runMigrations(t.bundle.db);
      expect(result.applied).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
