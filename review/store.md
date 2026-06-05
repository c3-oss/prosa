# Review: Store, Migrations, Schema

> Date: 2026-06-05
> Branch: master @ 114f89a
> Scope: internal/store, internal/server/storage, internal/server/handlers (db slices), migrations/local, migrations/server, projection version, FTS5

## Schema map

### Local (SQLite, `migrations/local/`)

```
devices(id PK, hostname, machine_id, friendly_name, fingerprinted_at)
  ^                                                      seed row: ('local','','','local')
  |
  | FK NO CASCADE (sessions.device_id -> devices.id)
  |
sessions(id PK,
         agent, device_id FK NOT NULL, project_path, project_remote,
         project_marker, started_at, last_activity_at, first_prompt,
         model, raw_path, raw_hash, raw_size,
         parent_session_id NULLABLE                <-- NO FK (intentional)
        )
  ^ ^ ^ ^
  | | | |
  | | | +-- sync_state(session_id PK FK CASCADE, last_hash, last_synced_at,
  | | |                projection_version)
  | | |
  | | +-- session_usage(session_id PK FK CASCADE, total_tokens, input_tokens,
  | |                   output_tokens, cached_tokens, cache_read_tokens,
  | |                   cache_creation_tokens)
  | |
  | +-- session_tools(session_id FK CASCADE, name, count, PK(session_id,name))
  |
  +-- turns(id PK, session_id FK CASCADE, role, content, ts, kind, tool_name)
        ^
        |
        +-- turns_fts(role, content) -- external-content fts5 over turns
              maintained by turns_ai / turns_ad triggers (WHEN kind!='thinking')

import_skips(session_id, reason, last_hash, skipped_at, projection_version,
             PK(session_id,reason))     <-- NO FK to sessions; session_id may be
                                            synthetic ('hermes-state-<hash[:12]>')

schema_migrations(version PK, applied_at)
```

### Server (Postgres, `migrations/server/`)

```
devices(id PK, hostname, machine_id, friendly_name,
        fingerprinted_at NOT NULL, last_sync, revoked_at)   -- no seed row
  ^
  | FK CASCADE (sessions.device_id -> devices.id)
  |
sessions(id PK,
         agent, device_id FK NOT NULL CASCADE,
         project_path, project_remote, project_marker,
         started_at TIMESTAMPTZ, last_activity_at TIMESTAMPTZ,
         first_prompt, model, raw_uri, raw_hash, raw_size BIGINT,
         parent_session_id NULLABLE                <-- NO FK (intentional)
        )
  ^ ^ ^
  | | |
  | | +-- sync_state(session_id PK FK CASCADE, last_hash, last_synced_at TIMESTAMPTZ,
  | |                projection_version INTEGER NOT NULL DEFAULT 1)
  | |
  | +-- session_usage(session_id PK FK CASCADE, total_tokens BIGINT, ...)
  |
  +-- session_tools(session_id FK CASCADE, name, count, PK(session_id,name))
  +-- turns(id BIGSERIAL PK, session_id FK CASCADE, role, content, ts TIMESTAMPTZ,
            kind, tool_name,
            content_tsv TSVECTOR GENERATED ALWAYS AS (
              CASE WHEN kind='thinking' THEN to_tsvector('simple','')
                   ELSE to_tsvector('simple', left(content, 800000))
              END) STORED)
        - GIN(content_tsv)
        - pg_notify('prosa.session.changed', NEW.id) on INSERT/UPDATE OF raw_hash

auth_codes(request_id PK, code UNIQUE, code_challenge, code_challenge_method,
           redirect_uri, client_state, hostname, fingerprint, state,
           expires_at, approved_at, used_at)         -- PKCE login state
device_tokens(token_hash PK, device_id FK CASCADE, issued_at, revoked_at)

schema_migrations(version PK, applied_at TIMESTAMPTZ)
```

The two schemas line up on the "session of record" projection. The server-only
surface (`auth_codes`, `device_tokens`, `last_sync`, `revoked_at`) carries the
multi-device coordination state that has no local analogue, and the local-only
`import_skips` table is a CLI-side decision cache that the server doesn't need.

## Summary

Posture is sound. The schemas are intentionally aligned where it matters; the
divergence (TIMESTAMPTZ vs RFC3339 text, BIGSERIAL vs INTEGER, GIN tsvector vs
FTS5 virtual table, `raw_uri` vs `raw_path`) is the right call for each side.
Migrations are simple, append-only, embedded via `embed.FS` (confirmed for both
`migrations/local/embed.go` and `migrations/server/embed.go`), and each `up.sql`
is run inside a transaction so partial application is impossible. The
projection_version stamp is consistently consulted by readers (LastHash,
LastImportSkip, server Push idempotency check) and stamped by writers (RecordSync,
RecordImportSkip, server recordSync); I found no place where it is bumped without
being honored or honored without being bumped.

The hermes FK bug fixed in 114f89a is genuinely the most serious latent class of
bug in this area, and after re-reading every FK-bearing insert path I am
satisfied it doesn't recur elsewhere. Every other `sync_state` insert is
preceded by an `UpsertSession` for the same real id (in the same call path), and
the synthetic `hermes-state-<hash[:12]>` id is now routed correctly through
`import_skips`, which has no FK.

The weakest area is **transactional boundaries on the importer-to-store path**:
each importer calls `UpsertSession` (its own tx), then `InsertTurns` (its own
tx), then `RecordSync` (no tx). A crash between the first and third call leaves
the local store in a state that the importer will heal on the next run (because
LastHash returns "no row" until RecordSync committed), but the brief window of
"session exists with no turns and no sync_state" is observable by concurrent
readers (panel, timeline, search). On the server side the analogous Push wraps
all three in a single tx, which is the right model — local should match.

The biggest **latent** risk is on the server: `Push` uploads to S3 before
opening the metadata transaction and never deletes on tx failure, so a metadata
write failure permanently orphans the S3 object. This is benign at single-user
scale but is unbounded in cost over a long server lifetime.

## Findings

### critical

None observed. The 114f89a FK fix removed the last known critical issue in this
area; verifying that no analogous "synthetic id written to a FK-bearing table"
construct exists was a primary aim of this review and it passes.

### high

**H1. Importer tx boundary is fragmented across three sink calls.**
`internal/store/sessions.go:32-116` (`UpsertSession`), `internal/store/turns.go:19-60`
(`InsertTurns`), and `internal/store/sync_state.go:40-50` (`RecordSync`) are three
independent transactions. Every importer (`internal/importers/*/importer.go`)
invokes them sequentially with no outer envelope. Failure modes:

- Process killed between `UpsertSession` and `InsertTurns`: the session row +
  session_tools + session_usage are visible, with **no turns**. Search will
  silently miss this session until the next sync; `show` will display
  metadata + first_prompt and "(no turns)". Self-healing on next sync but the
  window is open until then.
- Process killed between `InsertTurns` and `RecordSync`: the session looks
  complete but `sync_state` is empty, so the next sync re-imports — wasted
  work, no data loss.

The Sink interface as currently shaped (`pkg/importer/importer.go:70-75`) makes
the multi-call pattern explicit. Folding the three into one
`Sink.WriteSession(ctx, sess, tools, turns, hash)` method that the store
implements with a single `BeginTx` would close the window and match what
`internal/server/handlers/sessions.go:90-121` already does on the server. The
prepared-statement loop in `InsertTurns` is fine inside one tx — modernc.org/sqlite
serializes the inserts internally.

**H2. Server Push orphans S3 objects on metadata tx failure.**
`internal/server/handlers/sessions.go:83-122`. `h.Obj.Put(ctx, key, ...)` runs
**before** `h.Pool.Begin(ctx)`. If any of `upsertSession`, `replaceSessionUsage`,
`replaceSessionTools`, `replaceTurns`, `recordSync`, or the `UPDATE devices SET
last_sync` step errors, the deferred Rollback fires and the function returns
without ever touching S3. The just-uploaded object stays in the bucket forever
— there is no `RemoveObject` anywhere in `internal/server/`.

Concrete remediation options, in order of how heavy they are:

- Defer a best-effort `Obj.Client.RemoveObject(...)` that runs only on the
  error path (track success via a `committed bool` set after `tx.Commit`).
- Reorder: write metadata first, then upload, then a separate
  `UPDATE sessions SET raw_uri = $1` once the upload finishes. Visibility is
  worse (a row may be visible before raw is fetchable) but failure leaves no
  garbage.
- Lifecycle policy on the bucket that expires objects with no matching
  sessions.raw_uri after N days. Operationally the cheapest, but it needs
  out-of-band tooling.

The first option is the smallest fix and worth doing.

**H3. Server `Push` row updates `devices.last_sync` outside the idempotency
short-circuit.**
`internal/server/handlers/sessions.go:65-78` skips the rest of `Push` when
`lastHash == sess.RawHash && projectionVersion >= session.ProjectionVersion`,
returning `Skipped: true`. That means an idempotent re-push **does not** bump
`devices.last_sync`. The panel reads `last_sync` from `DevicesService.List`
(`internal/server/handlers/devices.go:38-46`) to show device activity. A device
that pushes-then-immediately-resynchronizes will appear idle to the panel until
something genuinely changes. Worth touching `last_sync` (or a separate
`last_seen`) before the early return so "active but converged" devices don't
look dormant.

### medium

**M1. Local search SELECT drops `parent_session_id`.**
`internal/store/search.go:108-131`. The SELECT lists every session column except
`s.parent_session_id`, and `scanSessions` is not reused — Search has its own
inline scan that doesn't read parent_session_id either. Every `SearchHit.Session`
therefore has `ParentSessionID == nil`, even for sessions that are subagent
children. The server's equivalent `Search` (sessions.go:511-532) DOES include
the column, so the local CLI and the remote-backed CLI now silently produce
different shapes for the same record. Add `s.parent_session_id` to the SELECT
and to the local scan list (mirror what `scanSessions` does in sessions.go:489).

**M2. ProjectMatch substring filter is unindexable.**
`internal/store/sessions.go:149-154` and `internal/server/handlers/sessions.go:166-174`
both build `(project_path LIKE %match% OR project_remote LIKE %match% OR
project_marker LIKE %match%)`. The leading `%` defeats every B-tree index on
these columns (local `idx_sessions_project_*`, server `sessions_project_*_idx`).
Every `--project foo` invocation does three full-column scans. Single-user scale
this is unobservable; at server scale with many devices and many sessions it's
the obvious thing to feel. Two options:

- Accept it (single-user scale, fine).
- Use case-insensitive equality where possible (`ProjectExact`, `ProjectRemote`,
  `ProjectMarker` are already supported) and document `--project` as "prefer the
  explicit forms for large stores".

For now this is medium; promote if it starts mattering.

**M3. Server `replaceTurns` is N×Exec inside the tx.**
`internal/server/handlers/sessions.go:983-1002` loops `tx.Exec` once per turn.
For a session with 5k turns this is 5k round-trips to Postgres. Local SQLite
(`InsertTurns`) does the same N-iteration loop but the round-trip is in-process
so it's cheap. On the server, prefer `tx.CopyFrom` (pgx supports it natively)
or batch inserts via `pgx.Batch`. This is the only hot loop in the Push path,
so it's the single biggest server-side throughput lever for users with large
transcripts.

**M4. Server `Manifest` JOINs `sync_state`; a session row without sync_state is
invisible to reconcile.**
`internal/server/handlers/sessions.go:572-580`. Today Push wraps `upsertSession`
and `recordSync` in one tx, so a sessions row never exists without sync_state.
But there is no schema-level guarantee. A future "import without push" or "DBA
restore from S3 only" path would silently drop those rows from reconcile.
Either:

- Add a NOT NULL invariant via a deferred constraint trigger that the absence
  of `sync_state` for a `sessions` row is illegal (overkill).
- Switch the JOIN to LEFT JOIN with `COALESCE(ss.last_hash, '')` and
  `COALESCE(ss.projection_version, 0)`. Clients will then see the row and
  force a re-push, which is the correct healing behavior.

The local `ListSessionsManifest` already does the right thing — no join, just
sessions.

**M5. `last_sync` on devices is updated every Push.**
`internal/server/handlers/sessions.go:112-117`. Hot row that every sync from a
given device contends on. Not an issue at single-user scale; concurrent pushes
from one device serialize at row-lock granularity. If concurrent ingestion ever
becomes a thing (multiple agents running in parallel and each pushing on their
own goroutine), this is the bottleneck.

**M6. No index on `session_usage.total_tokens`.**
`internal/server/handlers/sessions.go:245-247` exposes `sort_by=total_tokens`,
which becomes `ORDER BY su.total_tokens DESC NULLS LAST, s.started_at DESC`.
Without an index on `session_usage(total_tokens)` (or
`session_usage(total_tokens DESC, session_id)`) this is a sort over the full
joined result. Same story for local (no equivalent CLI sort today). Low cost
to add; useful if the panel grows by-tokens views.

**M7. `import_skips` has no FK to sessions but its session_id can be a real id
*or* a synthetic.**
`migrations/local/0006_import_skips.up.sql:1-8`. The fix in 114f89a uses
synthetic ids on purpose, so a FK would be wrong. But the existing data shape
mixes both kinds in one column with no marker. If anything ever joins
`import_skips` to `sessions` (right now nothing does — verified via grep), it
needs to either be reason-aware
(`reason='no_usage'` joins, `reason='state_seen'` doesn't) or use a discriminator
column. Documenting this in the migration comment would help future readers;
the table currently has zero inline documentation.

Suggested addition to `migrations/local/0006_import_skips.up.sql` (or a
follow-up migration's comment):

```sql
-- session_id may be either a real sessions.id (reason='no_usage') or a
-- synthetic marker id (reason='state_seen', value
-- 'hermes-state-<hash[:12]>'). No FK — see commit 114f89a for the bug that
-- motivated this shape.
```

### low

**L1. Down migrations can fail if applied out of order.**
`migrations/local/0005_turns_evidence.down.sql` drops the `kind` column, but
the triggers from `0007_thinking_excluded_from_fts.up.sql` reference
`new.kind`/`old.kind`. Rolling 0005 back without first rolling 0007 back will
fail with "no such column: kind". Same pattern on the server side (server
0006/0007). Migrate runner is up-only so this can only bite manual recovery;
add a sentence to `docs/architecture/store.md` recommending strict reverse
order.

**L2. `LastHash` returns the stale hash even when projection_version < current.**
`internal/store/sync_state.go:25-34`. The hash is read, the version is checked,
and on version mismatch we return `(hash, false, nil)`. Every existing caller
checks `found && prev == hash` so they correctly treat it as "no cache".
But anyone who omits the `found` check would silently see a half-truth.
Returning `("", false, nil)` would be more defensive. Cosmetic.

**L3. Migration runner uses `INSERT OR IGNORE` (local) and `ON CONFLICT DO
NOTHING` (server) for `schema_migrations`.**
`internal/store/migrations.go:62-65` and `internal/server/storage/pg.go:82-89`.
A successful migration that fails to record itself silently re-runs on next
boot. With idempotent migrations that's fine; with non-idempotent ones (none
today, but if `0001`'s `INSERT INTO devices('local',...)` ever escaped its
guarding migration it would PK-conflict on rerun), it would explode. Since
each migration runs in a tx that includes both the DDL and the
`schema_migrations` insert, a rerun should be impossible — flagging it for
defensive review.

**L4. SQLite write pool size unbounded.**
`internal/store/store.go:57-72` does not call `SetMaxOpenConns` on the
`db.SQL.DB` writer. The read-only path (line 100-101) bounds it to 4/2 but
the writer doesn't. modernc.org/sqlite serializes writes internally, so this
is harmless today; if a future caller fans out goroutines that all try to
write concurrently, you might want to bound this to 1 to make the
serialization explicit.

**L5. `formatTime` uses RFC3339Nano; `parseTime` accepts both Nano and Plain.**
`internal/store/sessions.go:514-526`. Writers always emit Nano; readers tolerate
both. Good. But the analytics heatmap (`internal/store/analytics.go:79`) does
`substr(s.started_at, 1, 10)` which depends on lexicographic ordering of the
text representation — works for RFC3339(Nano) but would silently break if any
caller ever wrote a non-RFC3339 string. Add a comment near `formatTime` that
the format choice is load-bearing for `substr(started_at, 1, 10)` to be a
valid date key.

**L6. Local `devices.id='local'` seed and `RebindLocalSessions`.**
`migrations/local/0001_init.up.sql:66-67` and
`internal/store/devices.go:108-131`. The migration plants a seed `local` device
so that `device.IDOnce()` runs after `s.UpsertDevice` produce a row that the FK
can target even on a v1 bundle restore. The bundle path inserted under
`device_id = 'local'` (the seed), and `RebindLocalSessions` migrates them. Good
design but it's now a no-op on any machine that's ever run a v2-aware sync.
Note in the migration comment that the row exists for backward compat with v1
bundles and is otherwise inert.

**L7. Server `sessions.device_id` has `ON DELETE CASCADE`; local does not.**
`migrations/server/0001_init.up.sql:25` vs `migrations/local/0001_init.up.sql:16`.
Today nothing deletes a device row (the revoke flow flips `revoked_at`, doesn't
DELETE), so both schemas behave the same in practice. The divergence is worth
either documenting as "intentional asymmetry" or aligning. If you ever add a
`devices` hard-delete path, the server will silently cascade-nuke sessions
while the local will refuse the delete — different and surprising behavior.

**L8. `parent_session_id` has no FK in either schema.**
`migrations/local/0008_subagent_edges.up.sql:7` and
`migrations/server/0008_subagent_edges.up.sql:5`. Intentional per the migration
comment ("walk parent->child without a join table"). But there's nothing
preventing a child from referencing a parent that was never imported. The
panel's "open parent" link will dead-end on those. Probably acceptable —
subagent transcripts and their parents are always imported together — but if
you ever add a "delete session" path, child rows will hold a dangling
parent_session_id. Note as "by design, but a future hazard."

### nit

**N1. Trailing space + minor symmetry in down files.**
`migrations/local/*.down.sql` and `migrations/server/*.down.sql` are uneven in
whitespace and structure. Nothing functional; would be a one-pass cleanup if
you ever do a doc/style sweep.

**N2. `internal/store/analytics.go:228-235` (AnalyticsErrors) embeds the
`errorTriggers` constant directly into the SQL string after the `tail` arg, so
it doesn't ride through `analyticsQuery`'s placeholder pipeline.** Today the
string is a hard-coded constant so injection is impossible, but the literal
sits next to user-bound `?` placeholders, which is mildly confusing to read.
Cosmetic.

**N3. `pgText` strips NUL bytes by replacing them with spaces
(`internal/server/handlers/sessions.go:1032-1034`).** Postgres TEXT columns
cannot store `\x00`, so this is necessary. Worth a comment on the function
saying "Postgres TEXT requires NUL stripping; transparently sanitize so importers
don't have to."

## What I checked

- Read every file in `migrations/local/` (8 up/down pairs) and
  `migrations/server/` (9 up/down pairs). For each, verified the up applies
  cleanly, the down reverses it where reversibility is achievable, and the up
  is wrapped in a single-statement-batch the runner can run inside one tx.
- Confirmed `migrations/local/embed.go` and `migrations/server/embed.go` both
  use `//go:embed *.sql` so the runner has access to every file in the
  package directory at compile time.
- Walked every FK declaration in both schemas (5 local, 5 server) and
  cross-referenced with every insert path in `internal/store/` and
  `internal/server/handlers/` to verify the parent row is created before the
  child. Particular attention to the synthetic-id case the hermes fix
  resolved.
- Read every SQL string in `internal/store/{sessions,turns,sync_state,
  search,analytics,backfill,devices,migrations,store}.go` and matched WHERE
  clauses to available indexes; same for `internal/server/handlers/
  {sessions,sessions_get_raw,devices,analytics,sse,auth,common}.go`.
- Traced the projection_version path through `pkg/session/types.go:106`,
  `internal/store/sync_state.go:18-50`, `internal/server/handlers/sessions.go:67-77,1004-1016`,
  `pkg/importer/importer.go:78-107`, and confirmed reader/writer symmetry
  on both sides.
- Re-read commit 114f89a and walked every other importer
  (`internal/importers/{claudecode,codex,cursor,gemini,antigravity,hermes}/importer.go`)
  to confirm none of them write a synthetic id through the
  `LastHash`/`RecordSync` (sync_state) pair — they correctly use only real
  session ids there.
- Followed the FTS5 trigger chain through `migrations/local/0001` and
  `migrations/local/0007` to confirm the `WHEN kind != 'thinking'` guard is
  symmetric on AI and AD triggers and that `InsertTurns` (delete-then-insert)
  produces the correct net effect across kind changes.
- Verified the SQLite pragmas (`store.go:53-55`) include WAL, foreign_keys=ON,
  synchronous=NORMAL, busy_timeout=5s on the writer and mode=ro,
  foreign_keys=ON, busy_timeout=5s with bounded pool on the reader.
- Confirmed the server uses `pgxpool.NewWithConfig` and inherits pool sizing
  from `PROSA_DB_URL` query params (`internal/server/storage/pg.go:23-37`).
- Searched the codebase for `DELETE FROM sessions` and `RemoveObject` — both
  yield zero hits, so the orphan-S3-on-tx-failure scenario is unmitigated.

## Recommendations

In rough priority order:

1. **Collapse `UpsertSession` + `InsertTurns` + `RecordSync` into a single
   `Sink.WriteSession` method on the local store** (high). Wrap the three
   existing implementations inside one `BeginTx` and have every importer call
   the new method. This closes the partial-write window flagged in H1 and
   brings the local path into structural parity with the server's `Push` tx.

2. **Defer-cleanup the S3 upload on metadata tx failure** (high). In
   `SessionsHandler.Push`, track a `committed` flag set after `tx.Commit`
   succeeds and, on the deferred error path, call
   `h.Obj.Client.RemoveObject(ctx, h.Obj.Bucket, key, ...)` best-effort with a
   logged warning.

3. **Touch `devices.last_sync` even on idempotent Push short-circuit** (high).
   Move the `UPDATE devices SET last_sync` outside the tx so it runs on every
   call, or fold it into the early-return path. The simplest fix is to do the
   UPDATE before the idempotency check.

4. **Add `parent_session_id` to local Search's SELECT** (medium). One-line
   change in `internal/store/search.go:108-131` plus matching scan binding.

5. **Switch server `replaceTurns` to `pgx.CopyFrom`** (medium). For sessions
   with thousands of turns, this is a 100x kind of difference.

6. **Switch server `Manifest`'s JOIN to LEFT JOIN with coalesced version=0**
   (medium). Robustness against a future "session without sync_state" state.

7. **Add an in-migration comment to `import_skips`** (medium-low). Document
   that `session_id` may be a synthetic state-marker id and is intentionally
   FK-free; reference 114f89a.

8. **Document the down-migration ordering hazard** (low). One paragraph in
   `docs/architecture/store.md` saying "down migrations must be applied in
   strict reverse order; the trigger introduced in 0007 references the column
   dropped by 0005-down."

9. **Decide on `sessions.device_id ON DELETE` alignment** (low). Either align
   local with server (add CASCADE) or document the asymmetry. Today it's
   invisible because nothing deletes devices.

10. **Tighten `LastHash` return signature** (low). Return `("", false, nil)`
    on version mismatch so the function never surfaces a stale value to a
    caller that forgot to check `found`.

Areas I'd push back on changing:

- The split between `sync_state` (real ids) and `import_skips` (real or
  synthetic ids) is the right shape; do not re-merge.
- The local FTS5 tokenizer (`porter unicode61`) deliberately differs from the
  server's `simple` — local users want stemming, server queries don't. Keep.
- `raw_path` (local) vs `raw_uri` (server) divergence reflects "file on disk"
  vs "object in bucket" semantics. Keep.
- Bumping `ProjectionVersion` is consistent and well-discipled; the v6 → v7
  → v8 history in `pkg/session/types.go:86-106` is exemplary. Keep the
  convention.
