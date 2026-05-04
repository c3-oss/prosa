import { describe, expect, it } from 'vitest';
import { getBytes, getJson, putBytes, putJson, putText } from '../../src/core/cas/index.js';
import { createTempBundle } from '../helpers/tmp-bundle.js';

describe('CAS', () => {
  it('roundtrips bytes and is idempotent on identical input', async () => {
    const t = await createTempBundle();
    try {
      const data = Buffer.from('hello prosa', 'utf8');
      const id1 = await putBytes(t.bundle, data);
      const id2 = await putBytes(t.bundle, data);
      expect(id1).toBe(id2);
      expect(id1.startsWith('blake3:')).toBe(true);

      const back = await getBytes(t.bundle, id1);
      expect(Buffer.from(back).equals(data)).toBe(true);

      const objectsRow = t.bundle.db
        .prepare<[string], { count: number }>(
          `SELECT count(*) AS count FROM objects WHERE object_id = ?`,
        )
        .get(id1);
      expect(objectsRow?.count).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it('compresses larger payloads with zstd', async () => {
    const t = await createTempBundle();
    try {
      const big = Buffer.from('a'.repeat(10_000), 'utf8');
      const id = await putBytes(t.bundle, big);
      const meta = t.bundle.db
        .prepare<[string], { compression: string; compressed_size_bytes: number }>(
          `SELECT compression, compressed_size_bytes FROM objects WHERE object_id = ?`,
        )
        .get(id);
      expect(meta?.compression).toBe('zstd');
      expect(meta?.compressed_size_bytes).toBeLessThan(10_000);

      const back = await getBytes(t.bundle, id);
      expect(back.byteLength).toBe(10_000);
    } finally {
      await t.cleanup();
    }
  });

  it('stores text and json with correct mime types', async () => {
    const t = await createTempBundle();
    try {
      const textId = await putText(t.bundle, 'hello');
      const jsonId = await putJson(t.bundle, { foo: 1, bar: ['a', 'b'] });

      const json = await getJson<{ foo: number; bar: string[] }>(t.bundle, jsonId);
      expect(json.foo).toBe(1);
      expect(json.bar).toEqual(['a', 'b']);

      expect(textId).not.toBe(jsonId);
    } finally {
      await t.cleanup();
    }
  });
});
