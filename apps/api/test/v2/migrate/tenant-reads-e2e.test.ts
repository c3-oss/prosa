// Lane 9 — CQ-158 end-to-end migrate -> reads gate.
//
// Boots a v2-only PGlite + Fastify with the v2 plugin mounted
// (migrate + reads), stubs ProsaAuth so `getSession` returns a fixed
// owner of the tenant (the same CQ-124 workaround the Lane 7 slice 11
// smoke uses), seeds `legacy_v1_source_files` + preserved bytes, POSTs
// `/v2/migrate/tenant`, then POSTs `/v2/reads/sessions/list` and
// asserts the migrated session is returned through the read API.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ProsaAuth } from '@c3-oss/prosa-api'
import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'

import { registerV2Routes } from '../../../src/v2/index.js'
import { createLocalReceiptSigner } from '../../../src/v2/signing/local-signer.js'

const TENANT_ID = 'tnt-cq158'
const USER_ID = 'usr-cq158'

type Harness = {
  app: FastifyInstance
  pglite: PGlite
  rawExec: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>
  transaction: <T>(fn: (tx: <Row>(sql: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>) => Promise<T>
  objectStore: MemoryObjectStore
  tmpRoot: string
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-cq158-'))
  const pglite = new PGlite()
  await applySchemaV2(pglite)

  type Row = Record<string, unknown>
  const rawExec = async <R = Row>(sql: string, params: unknown[] = []): Promise<R[]> => {
    const res = await pglite.query<R>(sql, params)
    return res.rows
  }
  const transaction = async <T>(
    fn: (tx: <R = Row>(sql: string, params?: unknown[]) => Promise<R[]>) => Promise<T>,
  ): Promise<T> => {
    await pglite.exec('BEGIN')
    try {
      const result = await fn(rawExec)
      await pglite.exec('COMMIT')
      return result
    } catch (err) {
      await pglite.exec('ROLLBACK')
      throw err
    }
  }

  // CQ-124 workaround: stub ProsaAuth so getSession returns a fixed
  // owner of the test tenant.
  const stubAuth: ProsaAuth = {
    handler: async () => new Response('not used', { status: 200 }),
    api: {
      getSession: (async () => ({
        session: { activeOrganizationId: TENANT_ID },
        user: { id: USER_ID, email: 'cq158@example.com', name: 'CQ158' },
      })) as ProsaAuth['api']['getSession'],
      signUpEmail: (async () => null) as ProsaAuth['api']['signUpEmail'],
      signInEmail: (async () => null) as ProsaAuth['api']['signInEmail'],
      signOut: (async () => null) as ProsaAuth['api']['signOut'],
      createOrganization: (async () => null) as ProsaAuth['api']['createOrganization'],
      setActiveOrganization: (async () => null) as ProsaAuth['api']['setActiveOrganization'],
      listOrganizations: (async () => null) as ProsaAuth['api']['listOrganizations'],
      createInvitation: (async () => null) as ProsaAuth['api']['createInvitation'],
      deviceCode: (async () => null) as ProsaAuth['api']['deviceCode'],
      deviceToken: (async () => null) as ProsaAuth['api']['deviceToken'],
      deviceVerify: (async () => null) as ProsaAuth['api']['deviceVerify'],
    },
  }

  // Migrate + read routes consult `member` to resolve memberRole on
  // each call; seed an owner row for the test tenant.
  await rawExec(
    `CREATE TABLE IF NOT EXISTS member (
       id TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'member',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  await rawExec(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    'mbr-cq158',
    TENANT_ID,
    USER_ID,
    'owner',
  ])

  const objectStore = new MemoryObjectStore()
  const app = Fastify({ logger: false })
  registerV2Routes(app, {
    auth: stubAuth,
    rawExec,
    transaction,
    objectStore,
    runtimeMode: 'test',
    signer: createLocalReceiptSigner({ kidPrefix: 'cq158' }),
  })
  await app.ready()

  return {
    app,
    pglite,
    rawExec,
    transaction,
    objectStore,
    tmpRoot,
    close: async () => {
      await app.close()
      await pglite.close()
      await rm(tmpRoot, { recursive: true, force: true })
    },
  }
}

async function seedCodexSource(
  h: Harness,
  storeId: string,
  sessionSuffix: string,
): Promise<{ sourceFileId: string; bytes: Uint8Array; storageKey: string }> {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2025-01-02T03:04:05.123Z',
      payload: { id: `sess_codex_${sessionSuffix}`, cwd: '/repo' },
    },
    {
      type: 'response_item',
      timestamp: '2025-01-02T03:04:06.000Z',
      payload: { role: 'user', content: [{ type: 'input_text', text: `hello-${sessionSuffix}` }] },
    },
  ]
  const bytes = new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)
  const hashBytes = blake3(bytes)
  const hash = Array.from(hashBytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const storageKey = `tenants/${TENANT_ID}/v1/objects/${sessionSuffix}.zst`
  await h.objectStore.putIfAbsent(
    storageKey,
    (async function* () {
      yield bytes
    })(),
    {
      hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: bytes.byteLength,
      compressedSize: bytes.byteLength,
      contentType: 'application/x-ndjson',
    },
  )
  const sourceFileId = `sf_codex_${sessionSuffix}_${hash.slice(0, 8)}`
  await h.rawExec(
    `INSERT INTO legacy_v1_source_files (
       tenant_id, store_id, source_file_id, source_tool, path, file_kind, content_hash, storage_key, size_bytes
     ) VALUES ($1, $2, $3, 'codex', $4, 'session_jsonl', $5, $6, $7)
     ON CONFLICT (tenant_id, source_file_id) DO NOTHING`,
    [
      TENANT_ID,
      storeId,
      sourceFileId,
      `/legacy/codex/rollout-${sessionSuffix}.jsonl`,
      hash,
      storageKey,
      bytes.byteLength,
    ],
  )
  return { sourceFileId, bytes, storageKey }
}

describe('CQ-158 end-to-end: migrate -> sessions/list', () => {
  it('returns the migrated session via /v2/reads/sessions/list after /v2/migrate/tenant', async () => {
    const h = await bootHarness()
    try {
      const storeId = 'store-cq158'
      await seedCodexSource(h, storeId, 'one')

      const migrateResponse = await h.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          'x-prosa-tenant-id': TENANT_ID,
        },
        payload: { tenantId: TENANT_ID, storeId },
      })
      expect(migrateResponse.statusCode).toBe(200)
      const migrateBody = migrateResponse.json() as {
        receiptId: string
        storeIds: string[]
        receiptIdsByStore: Record<string, string>
        gaps: unknown[]
      }
      expect(migrateBody.gaps).toEqual([])
      expect(migrateBody.storeIds).toEqual([storeId])
      const receiptId = migrateBody.receiptIdsByStore[storeId]
      expect(receiptId).toBeDefined()

      const listResponse = await h.app.inject({
        method: 'POST',
        url: '/v2/reads/sessions/list',
        headers: { 'content-type': 'application/json', 'x-prosa-tenant-id': TENANT_ID },
        payload: { limit: 50 },
      })
      expect(listResponse.statusCode).toBe(200)
      const listBody = listResponse.json() as {
        rows: Array<{ id: string; storeId: string; receiptId: string; sourceTool: string }>
      }
      expect(listBody.rows.length).toBeGreaterThan(0)
      const owned = listBody.rows.find((r) => r.storeId === storeId)
      expect(owned).toBeDefined()
      expect(owned!.receiptId).toBe(receiptId)
      expect(owned!.sourceTool).toBe('codex')
    } finally {
      await h.close()
    }
  }, 60_000)

  it('CQ-158 same-size raw_bytes_corrupted fails closed: no authority, no archive, no projection_session', async () => {
    const h = await bootHarness()
    try {
      const storeId = 'store-corrupt'
      // Seed a legacy source row whose content_hash points at one
      // payload, then upload DIFFERENT bytes of the same length to
      // the storage key. tryFetch must catch the BLAKE3 mismatch and
      // record `raw_bytes_corrupted`.
      const honestBytes = new TextEncoder().encode(
        `${JSON.stringify({ type: 'session_meta', timestamp: '2025-01-02T03:04:05.123Z', payload: { id: 'sess_honest', cwd: '/r' } })}\n`,
      )
      const honestHash = Array.from(blake3(honestBytes), (b) => b.toString(16).padStart(2, '0')).join('')
      const storageKey = `tenants/${TENANT_ID}/v1/objects/corrupt.zst`
      const corrupted = new Uint8Array(honestBytes.byteLength)
      for (let i = 0; i < corrupted.length; i++) corrupted[i] = (honestBytes[i] ?? 0) ^ 0xff
      await h.objectStore.putIfAbsent(
        storageKey,
        (async function* () {
          yield corrupted
        })(),
        {
          hash: Array.from(blake3(corrupted), (b) => b.toString(16).padStart(2, '0')).join(''),
          hashAlgorithm: 'blake3',
          uncompressedSize: corrupted.byteLength,
          compressedSize: corrupted.byteLength,
          contentType: 'application/x-ndjson',
        },
      )
      await h.rawExec(
        `INSERT INTO legacy_v1_source_files (
           tenant_id, store_id, source_file_id, source_tool, path, file_kind, content_hash, storage_key, size_bytes
         ) VALUES ($1, $2, $3, 'codex', '/legacy/c.jsonl', 'session_jsonl', $4, $5, $6)`,
        [TENANT_ID, storeId, 'sf_corrupt', honestHash, storageKey, honestBytes.byteLength],
      )

      const migrateResponse = await h.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: { 'content-type': 'application/json', 'x-prosa-tenant-id': TENANT_ID },
        payload: { tenantId: TENANT_ID, storeId },
      })
      expect(migrateResponse.statusCode).toBe(200)
      const body = migrateResponse.json() as {
        gaps: Array<{ reason: string }>
        storeIds: string[]
        receiptIdsByStore: Record<string, string>
      }
      expect(body.gaps.some((g) => g.reason === 'raw_bytes_corrupted')).toBe(true)
      expect(body.storeIds).not.toContain(storeId)
      expect(body.receiptIdsByStore[storeId]).toBeUndefined()

      const auth = await h.rawExec<{ store_id: string }>(
        `SELECT store_id FROM remote_authority_v2 WHERE tenant_id = $1 AND store_id = $2`,
        [TENANT_ID, storeId],
      )
      expect(auth).toHaveLength(0)
      const sessions = await h.rawExec<{ session_id: string }>(
        `SELECT session_id FROM projection_session WHERE tenant_id = $1 AND store_id = $2`,
        [TENANT_ID, storeId],
      )
      expect(sessions).toHaveLength(0)
    } finally {
      await h.close()
    }
  }, 60_000)
})
