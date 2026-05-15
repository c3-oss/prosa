# Server sync lane 4: One-way promotion protocol

This lane defines the network protocol that promotes local `.prosa` data into a
remote tenant store. There is no pull protocol. After promotion, the server is
the canonical store and the CLI performs reads, reports, analytics, and exports
remotely.

## Goals

- Upload local sessions, raw records, and CAS objects to a tenant.
- Make upload idempotent across retries and concurrent devices.
- Verify remote query equivalence before deleting local bundle data.
- Avoid sending object bytes through JSON tRPC payloads.
- Preserve raw source bytes and enough metadata to rebuild projections.
- Do not recreate a local `.prosa` on other devices.

## Transport split

Use tRPC for control-plane operations:

- Authenticated context.
- Tenant and device validation.
- Upload planning.
- Batch commit.
- Promotion verification.
- Remote search, sessions, analytics, reports, and exports.

Use plain HTTP routes for object bytes:

- `PUT /objects/:objectId`
- `GET /exports/:exportId`

Every object route requires bearer auth and tenant membership. The server still
stores CAS bytes globally by hash, but object route authorization is tenant
aware through the upload batch or export ownership.

## Promotion flow

1. `sync.handshake`
   - Verifies server version, tenant membership, device identity, local schema
     version, and supported import/projection versions.
   - Returns server capabilities, limits, and whether the selected local store
     has already been promoted.

2. `sync.planUpload`
   - Client sends compact manifests for local source files, raw records,
     sessions, and object metadata.
   - Server returns missing object IDs and row pages that need insertion.

3. `PUT /objects/:objectId`
   - Client streams only missing CAS bytes.
   - Server verifies BLAKE3 and size before making metadata visible.

4. `sync.commitUpload`
   - Client sends projection rows and provenance links in dependency order.
   - Server inserts rows in tenant-scoped transactions.
   - Server marks affected read surfaces stale or schedules rebuild jobs.

5. `sync.verifyPromotion`
   - Server confirms committed row counts, object references, and selected
     sample queries.
   - The response includes a `promotionReceipt` that the CLI records before
     local cleanup.

6. Local cleanup
   - CLI removes the local `.prosa` bundle data after verification.
   - CLI keeps only remote authority metadata in user config.

## Data ordering

Upload manifests must preserve dependency order:

1. `objects` metadata
2. `source_files`
3. `import_batches`
4. `raw_records`
5. `projects`
6. `sessions`
7. `turns`
8. `events`
9. `messages`
10. `content_blocks`
11. `tool_calls`
12. `tool_results`
13. `artifacts`
14. `edges`
15. `search_docs`

The server may accept pages, but each page must be transactionally valid.

## Query equivalence

Promotion verification must prove that the remote tenant can answer the same
class of reads as the local bundle:

- Session count by source tool.
- Recent sessions listing.
- Search over `search_docs`.
- Tool-call and error summaries.
- A small sample of object reads referenced by messages or tool results.

The verification does not need to compare every row byte-for-byte during normal
sync. It must fail closed if required tables, objects, or search docs are
missing.

## Conflict model

The upload protocol is append-mostly:

- CAS objects are immutable by hash.
- Raw records are immutable.
- Sessions and projections use deterministic IDs and upsert only when the new
  row is equivalent or more complete.
- Derived rows can be replaced.

If two devices produce conflicting projection rows for the same deterministic
ID, the server stores the first committed row, rejects the conflicting row, and
records a sync error. The client can reproject locally only before cleanup; once
promotion succeeds, repair work happens on the server from preserved raw data.

## Failure handling

- Object uploaded but batch not committed: keep object unattached for a
  retention window.
- Batch committed but verification fails: keep local `.prosa` intact and report
  the server-side issue.
- Verification succeeds but cleanup fails: mark the store as remote-authoritative
  and retry cleanup on the next CLI command.
- Client loses connection during object upload: retry `PUT`; duplicate object
  is accepted as no-op after verification.
- Device is revoked: reject new handshakes and object routes.

## Acceptance criteria

- Uploading the same bundle twice is a no-op after the first successful commit.
- A failed upload can be retried without cleanup.
- After promotion, `prosa search` and `prosa sessions` read from the server.
- Device B can log in and query a session uploaded by device A without pulling
  a bundle.
- A malicious client cannot attach rows to a tenant it is not a member of.
- Large outputs stream outside tRPC JSON payloads.

