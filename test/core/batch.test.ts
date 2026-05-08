import { describe, expect, it } from 'vitest';
import { finishBatch, recordError, startBatch } from '../../src/core/ingest/batch.js';
import { createTempBundle, queryCount } from '../helpers/tmp-bundle.js';

describe('import batch lifecycle', () => {
  it('records errors with and without payloads and finishes the batch', async () => {
    const t = await createTempBundle();
    try {
      const batch = startBatch(t.bundle, 'codex', ['/tmp/example/sessions']);
      expect(batch.batch_id).toMatch(/^[0-9a-f]+$/);
      expect(batch.source_tool).toBe('codex');

      await recordError(t.bundle, batch.batch_id, {
        kind: 'parse_error',
        message: 'malformed jsonl line',
      });
      await recordError(t.bundle, batch.batch_id, {
        kind: 'discovery_warning',
        message: 'unreadable directory',
        payload: { path: '/skipped', reason: 'eperm' },
      });

      expect(queryCount(t.bundle.db, 'SELECT count(*) AS n FROM import_errors')).toBe(2);
      const errorWithPayload = t.bundle.db
        .prepare<[], { payload_object_id: string | null }>(
          `SELECT payload_object_id FROM import_errors
              WHERE kind = 'discovery_warning'`,
        )
        .get();
      expect(errorWithPayload?.payload_object_id).toBeTruthy();

      finishBatch(
        t.bundle,
        batch,
        {
          source_files_seen: 1,
          source_files_imported: 0,
          source_files_skipped: 0,
          raw_records: 0,
          sessions: 0,
          turns: 0,
          events: 0,
          messages: 0,
          content_blocks: 0,
          tool_calls: 0,
          tool_results: 0,
          artifacts: 0,
          edges: 0,
          errors: 2,
        },
        'failed',
      );

      const finalStatus = t.bundle.db
        .prepare<[], { status: string; finished_at: string | null }>(
          `SELECT status, finished_at FROM import_batches WHERE batch_id = ?`,
        )
        .get(batch.batch_id);
      expect(finalStatus?.status).toBe('failed');
      expect(finalStatus?.finished_at).toBeTruthy();
    } finally {
      await t.cleanup();
    }
  });
});
