import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeBundle, openOrInitBundle } from '../../src/core/bundle.js';
import { PROSA_SCHEMA_VERSION } from '../../src/core/version.js';

describe('bundle openOrInit', () => {
  it('initializes a missing bundle and reopens it on later calls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'prosa-bundle-'));
    const storePath = path.join(root, 'store');
    try {
      const created = await openOrInitBundle(storePath);
      try {
        expect(created.path).toBe(storePath);
        expect(created.manifest.schema_version).toBe(PROSA_SCHEMA_VERSION);
      } finally {
        closeBundle(created);
      }

      await expect(stat(path.join(storePath, 'manifest.json'))).resolves.toBeDefined();
      await expect(stat(path.join(storePath, 'prosa.sqlite'))).resolves.toBeDefined();
      await expect(stat(path.join(storePath, 'objects'))).resolves.toBeDefined();
      await expect(stat(path.join(storePath, 'raw', 'sources'))).resolves.toBeDefined();
      await expect(stat(path.join(storePath, 'search'))).resolves.toBeDefined();
      await expect(stat(path.join(storePath, 'exports'))).resolves.toBeDefined();

      const reopened = await openOrInitBundle(storePath);
      try {
        expect(reopened.path).toBe(storePath);
        expect(reopened.manifest.schema_version).toBe(PROSA_SCHEMA_VERSION);
      } finally {
        closeBundle(reopened);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
