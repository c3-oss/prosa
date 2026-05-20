// Lane 6 — p95 latency smoke evidence.
//
// The Lane 6 gate document names four p95 targets under fixture
// load:
//
//   - sessions/list             < 200 ms
//   - search/query              < 200 ms
//   - sessions/transcript p1    < 500 ms (typical session)
//   - artifacts/getText (1 MiB) < 1 s
//
// PGlite is not a Postgres performance benchmark — it runs the same
// SQL through a WASM build and is at least an order of magnitude
// slower than a real `pg` connection. The values we measure here
// are loose upper bounds (signed cursor verification, gate
// composition, conflict-resolved DISTINCT ON, FTS over a small
// document set) so we can flag a regression that *cratered*
// throughput long before a real benchmark would. The Lane 6 gate
// requires production-grade evidence on real Postgres; this smoke
// generates the p95 numbers reviewers can re-run on the contributor
// checkout and pins them under generous CI-friendly ceilings.

import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getArtifactText } from '../../../src/v2/reads/artifacts/get-text.js'
import { searchQuery } from '../../../src/v2/reads/search/query.js'
import { listSessions } from '../../../src/v2/reads/sessions/list.js'
import { getTranscriptPage } from '../../../src/v2/reads/sessions/transcript.js'
import { createInProcessCursorSigner } from '../../../src/v2/reads/shared/cursor-signer.js'

const tenantId = 't_a'
const storeId = 's_a'
const receiptId = 'rcp_a'

function makeRawExec(db: PGlite) {
  return async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await db.query<Row>(sql, params)
    return res.rows
  }
}

function p95(durationsMs: number[]): number {
  if (durationsMs.length === 0) return 0
  const sorted = [...durationsMs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx]!
}

async function seedFixture(db: PGlite, opts: { sessions: number; messagesPerSession: number; docs: number }) {
  await db.query(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())`,
    [tenantId, storeId, receiptId, 'aa'.repeat(16)],
  )
  for (let i = 0; i < opts.sessions; i += 1) {
    const sid = `ses_${String(i).padStart(4, '0')}`
    await db.query(
      `INSERT INTO projection_session
         (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
          parent_resolution, timeline_confidence, start_ts, end_ts, payload)
       VALUES ($1, $2, $3, $4, 'codex', $5, 'unresolved', 'high',
               (now() - ($6 * INTERVAL '1 minute'))::timestamptz,
               (now() - ($6 * INTERVAL '1 minute' - INTERVAL '1 minute'))::timestamptz,
               '{}'::jsonb)`,
      [tenantId, sid, storeId, receiptId, `src_${i}`, opts.sessions - i],
    )
  }
  for (let i = 0; i < opts.messagesPerSession; i += 1) {
    await db.query(
      `INSERT INTO projection_message
         (tenant_id, message_id, store_id, receipt_id, session_id, role, model, ordinal, payload)
       VALUES ($1, $2, $3, $4, $5, 'user', 'gpt-5', $6, '{}'::jsonb)`,
      [tenantId, `msg_p_${i}`, storeId, receiptId, 'ses_0000', i],
    )
  }
  for (let i = 0; i < opts.docs; i += 1) {
    const text = `lorem ipsum fox-${i % 10} dolor sit amet`
    await db.query(
      `INSERT INTO search_doc
         (tenant_id, doc_id, store_id, receipt_id, entity_type, entity_id, field_kind, text, text_tsv)
       VALUES ($1, $2, $3, $4, 'message', $2, 'message_text', $5, to_tsvector('english', $5))`,
      [tenantId, `doc_${i}`, storeId, receiptId, text],
    )
  }
}

const cursorSigner = createInProcessCursorSigner()
let db: PGlite
let store: MemoryObjectStore
const ARTIFACT_ID = 'art_p95_1mib'
const ARTIFACT_OBJECT_ID = 'blake3:p95_1mib_object'
const ARTIFACT_PACK = 'pack_p95_1mib'
const ARTIFACT_URI = 'object-packs/p95-1mib'

beforeAll(async () => {
  db = new PGlite()
  await applySchemaV2(db)
  await seedFixture(db, { sessions: 200, messagesPerSession: 50, docs: 200 })

  // 1 MiB artifact fixture for the L6.8 artifacts/getText target.
  store = new MemoryObjectStore()
  const body = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < body.length; i += 1) body[i] = i & 0xff || 0x20
  await store[PUT_PREVERIFIED_BYTES](
    ARTIFACT_URI,
    (async function* () {
      yield new Uint8Array(body)
    })(),
    { hash: 'h', hashAlgorithm: 'blake3', uncompressedSize: body.length, compressedSize: body.length },
  )
  await db.query(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri)
     VALUES ($1, $2, 'cas_object_pack', 1, $3, 'root', $4)`,
    [tenantId, ARTIFACT_PACK, body.length, ARTIFACT_URI],
  )
  await db.query(
    `INSERT INTO remote_pack_entry
       (tenant_id, pack_digest, entry_index, object_id, uncompressed_size, stored_offset, stored_length, stored_hash, compression)
     VALUES ($1, $2, 0, $3, $4, 0, $4, 'h', 'none')`,
    [tenantId, ARTIFACT_PACK, ARTIFACT_OBJECT_ID, body.length],
  )
  await db.query(`INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest) VALUES ($1, $2, $3)`, [
    receiptId,
    tenantId,
    ARTIFACT_PACK,
  ])
  await db.query(
    `INSERT INTO projection_artifact
       (tenant_id, artifact_id, store_id, receipt_id, source_tool, kind, object_id, byte_length, content_type, payload)
     VALUES ($1, $2, $3, $4, 'codex', 'text', $5, $6, 'text/plain', '{}'::jsonb)`,
    [tenantId, ARTIFACT_ID, storeId, receiptId, ARTIFACT_OBJECT_ID, body.length],
  )
}, 60_000)

afterAll(async () => {
  if (db) await db.close()
})

async function time<T>(fn: () => Promise<T>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

const SAMPLE_COUNT = 20

describe('Lane 6 p95 latency smoke (PGlite — loose CI ceilings)', () => {
  it('sessions/list p95 stays well under the Lane 6 target', async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      samples.push(await time(() => listSessions({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { limit: 50 })))
    }
    const observed = p95(samples)
    // PGlite ceiling — real Postgres should be much faster. The
    // Lane 6 contract names < 200 ms on real Postgres; we hold
    // PGlite to a generous 2 s so a regression that lost an index
    // or re-introduced N+1 still trips.
    expect(observed).toBeLessThan(2000)
    // eslint-disable-next-line no-console
    console.log(`[p95] sessions/list = ${observed.toFixed(1)} ms across ${SAMPLE_COUNT} samples`)
  })

  it('search/query p95 stays well under the Lane 6 target', async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      samples.push(
        await time(() => searchQuery({ rawExec: makeRawExec(db), cursorSigner }, tenantId, { q: 'fox', limit: 50 })),
      )
    }
    const observed = p95(samples)
    expect(observed).toBeLessThan(2000)
    // eslint-disable-next-line no-console
    console.log(`[p95] search/query = ${observed.toFixed(1)} ms across ${SAMPLE_COUNT} samples`)
  })

  it('artifacts/getText 1 MiB p95 stays under the Lane 6 target', async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      samples.push(
        await time(() =>
          getArtifactText({ rawExec: makeRawExec(db), objectStore: store }, tenantId, {
            artifactId: ARTIFACT_ID,
            maxBytes: 1024 * 1024,
          }),
        ),
      )
    }
    const observed = p95(samples)
    // Lane 6 production target is < 1 s for 1 MiB. PGlite + Memory
    // store ceiling here is 5 s to leave headroom for CI noise.
    expect(observed).toBeLessThan(5000)
    // eslint-disable-next-line no-console
    console.log(`[p95] artifacts/getText 1MiB = ${observed.toFixed(1)} ms across ${SAMPLE_COUNT} samples`)
  })

  it('sessions/transcript first-page p95 stays under the Lane 6 target', async () => {
    const samples: number[] = []
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      samples.push(
        await time(() =>
          getTranscriptPage({ rawExec: makeRawExec(db), cursorSigner }, tenantId, {
            sessionId: 'ses_0000',
            limit: 50,
          }),
        ),
      )
    }
    const observed = p95(samples)
    // The multi-pass transcript reconstruction is heavier than the
    // list reads. PGlite ceiling: 5 s; real Postgres target is
    // < 500 ms. Regression that adds an extra round-trip or drops
    // the index_session_idx still trips this.
    expect(observed).toBeLessThan(5000)
    // eslint-disable-next-line no-console
    console.log(`[p95] sessions/transcript first page = ${observed.toFixed(1)} ms across ${SAMPLE_COUNT} samples`)
  })
})
