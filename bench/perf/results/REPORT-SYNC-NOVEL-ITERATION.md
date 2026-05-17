# Sync performance continuation - novel iteration

Date: 2026-05-17

This round continued the sync work beyond the previous PR review. The focus was
to find optimizations that reduce request/query amplification without weakening
byte verification, idempotency, or tenant isolation.

## Implemented

1. Chunked CLI sync now uses object packs.
   - The chunked path in `apps/cli/src/cli/commands/sync.ts` was still uploading
     missing objects one `PUT /objects/:id` at a time.
   - It now reuses the existing `uploadMissingCasObjects` object-pack helper,
     preserving per-object fallback for non-packable or oversized entries.
   - The chunked test harness now accepts `/object-packs` and asserts the mixed
     chunked path uses packs with zero individual PUTs.

2. Object-pack catalog writes are set-based.
   - `POST /object-packs` no longer loops each entry through catalog, tenant
     proof, and location inserts.
   - The open-batch declaration proof for pack entries is also checked with one
     set-based query instead of one query per entry.
   - It bulk-inserts `remote_object`, `tenant_object`, and
     `remote_object_location`, then performs set-based compatibility checks.
   - Existing pack conflict tests still fail closed and fresh pack bytes are
     still deleted on catalog failure.

3. Materialized-object checks are set-based.
   - Plan, commit, and verify paths now load tenant/object/location/blob
     metadata for all declared objects in one query.
   - Object-store `head` and byte reads still run per object when required.
     In particular, commit and verify still perform `verifyBytes: true`.
   - This removes duplicate location lookups and redundant `tenant_object`
     lookups without trusting a fresh plan as proof.

4. Projection manifest rows are inserted in bulk.
   - `sync_batch_projection_manifest` moved from one insert per promoted entity
     to one `INSERT ... SELECT FROM unnest(...)`.
   - Projection data rows still use the existing insert-or-verify conflict
     semantics, so this is intentionally less invasive than the full
     projection-upsert PR.

5. Added a synthetic phase probe.
   - `bench/bench-sync-phase-probe.ts` runs an in-process API sync against
     PGlite and `MemoryObjectStore`.
   - It records per-phase wall time, counted `rawExec` SQL, top SQL shapes,
     object-store calls, cold promotion, idempotent commit replay, and warm
     re-promotion.
   - Raw outputs from this round:
     - `sync-phase-probe-before-setbased.json`
     - `sync-phase-probe-after-setbased.json`

## Synthetic Probe Results

Command:

```sh
TS_NODE_PROJECT=apps/api/tsconfig.json \
node --import @swc-node/register/esm-register \
  bench/bench-sync-phase-probe.ts \
  --objects 100 --sessions 50 \
  --output /tmp/prosa-sync-phase-probe-after-proj-manifest.json
```

Fixture:

- 100 CAS objects
- 50 synthetic sessions
- 500 projection rows, covering all 10 projection entity families

Important caveat: this is Fastify inject + PGlite + memory storage. It still
uses the individual object PUT route rather than the CLI object-pack path. Treat
it as query-amplification and phase-attribution evidence, not final wall-time
evidence for Postgres, MinIO, or real network paths.

| Phase | Before SQL calls | After SQL calls |
| --- | ---: | ---: |
| cold plan | 106 | 7 |
| cold commit | 1813 | 1015 |
| cold verify | 409 | 10 |
| warm plan | 306 | 7 |
| warm commit | 1313 | 515 |
| warm verify | 409 | 10 |

Derived SQL amplification:

- Before: 32.28 counted SQL calls per object, 6.46 per projection row.
- After: 19.32 counted SQL calls per object, 3.86 per projection row.

Object-store verification was intentionally preserved:

- Cold commit after changes: 100 `head` + 100 `get`.
- Warm commit after changes: 100 `head` + 100 `get`.
- Cold/warm verify after changes: 100 `head` + 100 `get`.

The biggest remaining counted SQL source is projection row insert-or-verify:
500 row-level selects on warm commit, and 500 row-level inserts on cold commit.
That points at the full projection-upsert batching work as the next high-value
server-side step.

## Research Notes

External research supports the main direction:

- S3-compatible stores reward request amortization and large sequential writes;
  AWS documents per-prefix request scaling and multipart thresholds.
  Sources: https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html,
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- Postgres ingest generally performs better with set-based `UNNEST`/bulk load
  patterns than row-at-a-time statements. Source:
  https://www.tigerdata.com/blog/boosting-postgres-insert-performance
- Idempotent retry design should prefer deterministic keys and backoff with
  jitter rather than exactly-once assumptions. Source:
  https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
- Bloom filters can reduce expensive membership checks while requiring fallback
  verification for false positives. Source:
  https://aws.amazon.com/blogs/database/implement-fast-space-efficient-lookups-using-bloom-filters-in-amazon-elasticache/
- Large JSON/tRPC payloads may become CPU and memory bottlenecks; binary or
  columnar encodings plus HTTP compression are plausible future experiments.
  Sources: https://www.gravitee.io/blog/protobuf-vs-json,
  https://en.wikipedia.org/wiki/HTTP/2

## Next Experiments

1. Docker/Postgres/MinIO benchmark lane.
   - Re-run the same phases with a clean DB per repeat.
   - Reset and capture `pg_stat_statements` per phase.
   - Run 5-10 repeats per configuration.
   - Sweep object-count, object-size, object-pack max bytes, and object
     concurrency.

2. Full projection row batching.
   - Extend the safer PR #42 direction: bulk insert rows and batch-verify
     conflicts after insert.
   - Keep replay conflicts exact. Do not convert to blind `ON CONFLICT DO
     UPDATE`.

3. Batch-scoped upload proofs.
   - A possible next design is a short-lived `sync_batch_object_upload_proof`
     table populated only by verified PUT/pack routes.
   - Commit could use those proofs to avoid re-reading bytes uploaded in the
     same open batch, but this needs a strict safety model:
     proof scoped by tenant, batch, user, object id, hash, sizes, storage
     location, and TTL; fallback to `verifyBytes` for anything not proven.

4. Inventory/Bloom/Merkle remote membership.
   - For very large warm syncs, even 1 object-store `head` per object may be too
     much.
   - A tenant-scoped inventory snapshot or Bloom filter can reduce lookup
     volume, but false positives must never become commits without later
     byte/location verification.

5. Protocol payload work.
   - Measure `commitUpload` JSON serialization and Zod/tRPC parse cost with
     Node CPU profiles.
   - Test request compression or a binary/columnar hot-path endpoint for large
     projection payloads.

6. Observability.
   - Add OpenTelemetry spans around plan, object upload, commit, verify, DB
     query groups, and object-store operations.
   - Use `clinic flame`, Node `--prof`, and Postgres `EXPLAIN (ANALYZE,
     BUFFERS)` on top query shapes.
