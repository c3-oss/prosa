// Shared helpers for Lane 9 server-side migrate tests.

import type { TestApp } from '../../helpers/test-app.js'

export async function signupWithTenant(
  t: TestApp,
  email: string,
  tenantName: string,
  tenantSlug: string,
): Promise<{ token: string; user: { id: string; email: string }; tenant: { id: string } }> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  if (response.statusCode !== 200) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`)
  }
  return (
    response.json() as {
      result: { data: { token: string; user: { id: string; email: string }; tenant: { id: string } } }
    }
  ).result.data
}

export async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

/**
 * Seed a single legacy_v1_source_files row and its preserved bytes
 * into the test object store. Returns the source_file_id.
 */
export async function seedLegacyCodexSource(opts: {
  t: TestApp
  tenantId: string
  storeId: string
  sessionId: string
  storageKey: string
}): Promise<{ sourceFileId: string; bytes: Uint8Array }> {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: opts.sessionId, cwd: '/repo' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    },
  ]
  const bytes = new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  const blake3Mod = await import('@noble/hashes/blake3')
  const hashBytes = blake3Mod.blake3(bytes)
  const hash = Array.from(hashBytes, (b) => b.toString(16).padStart(2, '0')).join('')
  await opts.t.objectStore.putIfAbsent(opts.storageKey, asyncOnce(bytes), {
    hash,
    hashAlgorithm: 'blake3',
    uncompressedSize: bytes.byteLength,
    compressedSize: bytes.byteLength,
    contentType: 'application/x-ndjson',
  })
  const sourceFileId = `sf_codex_${hash.slice(0, 16)}`
  await opts.t.db.rawExec(
    `INSERT INTO legacy_v1_source_files (
       tenant_id, store_id, source_file_id, source_tool, path, file_kind, content_hash, storage_key, size_bytes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, source_file_id) DO NOTHING`,
    [
      opts.tenantId,
      opts.storeId,
      sourceFileId,
      'codex',
      `/legacy/codex/rollout-${opts.sessionId}.jsonl`,
      'session_jsonl',
      hash,
      opts.storageKey,
      bytes.byteLength,
    ],
  )
  return { sourceFileId, bytes }
}

/**
 * Ensure the `legacy_v1_receipt` source table exists for tests that
 * exercise the archive flow. The schema is intentionally minimal —
 * production v1 receipts already live in their own table; tests just
 * need a place to seed rows the migrator will archive.
 */
export async function ensureLegacyV1ReceiptTable(t: TestApp): Promise<void> {
  await t.db.rawExec(
    `CREATE TABLE IF NOT EXISTS legacy_v1_receipt (
       receipt_id TEXT PRIMARY KEY,
       tenant_id  TEXT NOT NULL,
       store_id   TEXT NOT NULL,
       payload    JSONB NOT NULL,
       signature  JSONB
     )`,
  )
}
