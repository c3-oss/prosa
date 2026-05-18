# 15 — Review of proposal 2 (design closeout)

A two-specialist review of the v2.0.1 design closeout, validated against the original review and the current source. Each subsystem (local store + importers; server + reads) was reviewed independently for whether the closeout actually closes the original gaps and whether the closures introduce new issues. Line numbers reference the closeout unless stated otherwise.

## Verdict

**Closeout binds. All 12 load-bearing gaps and the 5 supporting items from the prior review close at the architectural level. No new architectural blockers were introduced.** Two operationally significant items must be pinned before code begins (client-side zstd window enforcement; `tenant_session_current` consistency model). Nine smaller items belong inside the three spec freezes (`bundle-v2.md`, `promotion-protocol-v2.md`, `read-api-v2.md`). The implementation path proposed by the architect — freeze three specs first, then build — is correct.

The three most consequential decisions in this closeout are sound and should be accepted:

1. **`LogicalImportUnit` replaces file-shaped `ImportFrame`.** Closes Hermes dual-source merging and makes Codex's deferred parent linking an explicit `GraphResolver` step rather than a global `UPDATE`.
2. **Deterministic shard actors own uniqueness keys.** Closes the multi-RocksDB race that splitting the writer lock into 16 independent stores would otherwise introduce.
3. **`receipt_pack_grant` replaces `tenant_object`.** Removes the billions-of-rows scaling cliff and keeps tenant isolation with pack-level grants instead of per-object grants.

## What now closes

| # | Gap | Closure | Quality |
|---|---|---|---|
| G1 | Late-bound `parent_session_id` and Parquet immutability | `GraphResolver` + `LateBindingIndex` pre-seal; `SessionFixupV2` for cross-epoch corrections; ClickHouse view coalesces base + fixups (§1). | Clean for `parent_session_id`. Needs `end_ts`/`model_last` added to fixup payload — see L1 below. |
| G2 | Shard key + atomic uniqueness | `shardForKey(keyspace, canonicalKey) = blake3(...) % 16` + single writer actor per shard + `PutIfAbsent`/`Reserve`/`CommitReservation` command vocabulary (§2). | Clean. UNIQUE atomicity preserved by deterministic routing. |
| G3 | Hermes dual-source merge | `LogicalImportUnit` replaces `ImportFrame`; explicit Hermes flow groups by `source_session_id` with stated tie-breakers (§3). | Clean. Codex's late-parent case correctly delegated to `GraphResolver`, not folded into the unit. |
| G4 | Pack writer contention | 8 CAS pack writers sharded by `blake3(object_id) % 8`, 4 raw-source pack writers, per-entity-type graph segment writers (§4). | Clean structural escape from the single-writer lock. |
| G5 | Streaming validation memory | Streaming decoder, decompressed bytes never accumulated; ~12–16 MiB worst case per upload, 4 concurrent per worker (§5). | Closes the OOM risk but depends on client-side zstd window cap — see L1 below. |
| G6 | Multi-machine same-tenant union view | `tenant_store_authority` per `(tenant, store)` + `tenant_session_current` per `(tenant, global_session_key)` with four-step conflict rule (§6). | Closes the union gap. Write ordering relative to authority swap needs pinning — see L2 below. |
| G7 | Device key history and rotation | Append-only `device_public_key` table with `key_id` and `superseded_by_key_id`; cross-signing on rotation; `clientSignatureStatus` enum supports v2.0 bootstrap (§7). | Clean. Key archive is implicit — see L7 below for a one-line clarification. |
| G8 | `MissingObjectPlan` canonical ordering | Pinned to `hash_alg ASC, hash_hex ASC, uncompressed_size ASC, compression ASC`; `inventoryDigest` ensures both sides agree; `needs_inventory` is a named protocol state (§8). | Clean. |
| G9 | `tenant_object` row-per-object scale | Removed entirely. `remote_pack` + `remote_pack_entry` + `receipt_pack_grant` with `all_entries`/`filtered_entries` modes (§9). | Clean. Pack GC ownership not specified — see L5 below. |
| G10 | CLI receipt refresh | 60 s TTL; `--refresh` force; HTTP 412 mid-command triggers refresh+retry or stop with explicit message; `--offline`/`--local` print stale warning (§10). | Clean. Cache-skip behavior within TTL needs one sentence — see L6 below. |
| G11 | `session_blob_pack` schema | Page format with explicit limits (1 MiB max page, 32 KiB inline-block limit, 128 messages target / 256 hard), cursor-paged, CAS refs for large bodies (§11). | Clean. Per-page joint constraint needs explicit statement — see L8 below. |
| G12 | Cold no-op compile target | Warm path 0.5–2.5 s; cold rebuild after RocksDB loss 20–90 s honestly reported as repair path (§12). | Clean honesty. Cold rebuild crash safety not specified — see L3 below. |
| (13) | Background audit ownership | Separate `prosa-audit-worker`; multi-cadence schedule; `pack_audit_state` + `receipt_audit_state`; quarantine/degraded/invalidated states with explicit drift responses (§13). | Closes. Re-promotion trigger mechanism needs spec hook — see L9 below. |
| (14) | MCP `--authority auto` | Pinned at server startup; refresh only on explicit signal, `prosa.refresh_authority` tool, server 412, or process restart (§14). | Clean. |
| (15) | Tantivy topology | Separate stateful fleet with `search_generation` and `search_generation_current` tables; Postgres LISTEN/NOTIFY invalidation; explicit read flow with 503 fallback (§15). | Clean. Generation retirement / GC not specified — see L10 below. |
| (16) | Parquet compaction | Triggers stated; **physical compaction does not change logical roots** because receipts hash rows, not file bytes (§16). | Clean rule. Merkle input must be pinned to row content — see L11 below. |
| (17) | CLI surface mapping | 1:1 mapping table from current to v2 commands; analytics view names and projected columns remain stable contract (§17). | Mostly clean. TUI surface choice left open — see L12 below. |

## Strong endorsements

These choices are not just adequate; they should survive into the spec freezes without further debate:

- **Re-projection invariant made explicit (line 1150).** "A raw_source_pack MUST NOT be deleted while any committed epoch manifest references it." This is the rule the current architecture only carries implicitly via the three-layer model. Naming it eliminates a class of future contributor mistakes.
- **`parent_resolution` field on `SessionV2` (line 868).** Telegraphs `inline | edge_derived | fixup_derived | unresolved` so consumers can reason about confidence at read time. Small column, large debugging value.
- **`needs_inventory` as a first-class protocol state (line 1224).** Promotes the inventory→bitmap dependency from "assumed agreed-upon ordering" to "explicit protocol step that fails closed when missing." Two-team interoperability becomes implementable.
- **Logical roots over rows, physical compaction free (line 803).** The compaction story holds together only because of this rule. Implementers will not get it right by default; the spec must pin the Merkle input shape (see L11).
- **`prosa-audit-worker` as a separate process (line 640).** Decouples drift detection from the API hot path and from per-batch verification. Without this separation, audit cost would either be skipped or would re-introduce the per-batch HEAD wave that v2 was designed to remove.

## Last-mile items to pin before the spec freeze

These items have no architectural ambiguity — they are gaps in the closeout text that a careful implementer would discover late and resolve inconsistently across subsystems. The three spec documents must pin them explicitly.

### `bundle-v2.md` must pin

**L1.** `SessionFixupV2` (line 56) currently covers `parent_session_id`, `timeline_confidence`, `title`, `summary`. Add `end_ts` and `model_last`. Hermes JSONL can extend a session after the SQLite row's `end_ts`/`model_last` are already written; Codex `compact` events populate `summary` after the session row. The fixup must propagate to `tenant_session_current` because the union-view conflict rule (line 289) uses `end_ts` as the primary sort key — a fixup that updates `end_ts` without refreshing the union row leaves the tenant view stale.

**L2.** Large-object pack assignment (line 175, "2 CAS large-object writers, objects >= 32 MiB, standalone"). Clarify that each large object becomes a **single-entry standalone pack** addressed by the same `PackRef[]` array, not pooled into the two writers as multi-entry packs. The two writers exist to bound concurrent fsync, not to pool objects.

**L3.** Cold rebuild crash safety (§12). The cold path rebuilds the RocksDB index from epoch manifests and Parquet over 20–90 s. A SIGKILL at second 15 leaves a partially populated index. The next run must either detect partial state and restart from scratch or resume from a `rebuild.progress` checkpoint naming the last epoch ingested. Pick one and write it down.

**L4.** Per-logical-session `Reserve` command (§3). The shard actor command vocabulary in §2 includes `Reserve`, but the Hermes / Gemini flow in §3 never invokes it. Two concurrent import workers discovering the same logical session from different physical files will both parse, CAS-store, and assemble draft projections redundantly. The spec must require a `Reserve` against the `session_key` shard before full parse.

**L5.** FK validation at epoch seal — what data structure? At 1M+ rows per epoch, a per-row RocksDB lookup during seal becomes a 40–80 s pass. Pick: in-memory `Set<id>` (working set ~50–80 MiB for 1M strings), a per-epoch Bloom filter for prior-epoch entities, or both. Without naming the structure, the seal cost is unbounded.

**L6.** `workspace_hint` propagation. Today `source_files.workspace_hint` (Cursor) implicitly informs project association. `SourceStateV2` and `RawSourcePackEntryV2` carry it (line 1120), but `SessionV2`/`ProjectV2` have no corresponding field. The inferred path needs to be either explicit on the projection or stated as "lives only on source_files."

### `promotion-protocol-v2.md` must pin

**L7.** **Client-side zstd encoder window cap is mandatory, not just a server decoder limit.** §5 mentions `maxZstdWindowBytes = 8 MiB` (line 226) as a server decoder cap, but if a client encodes with a 128 MiB window the streaming validation budget collapses. The pack-format definition must require pack producers to use `window_size <= 8 MiB` (e.g. `--long=23` for the reference zstd implementation). Pack ingestion must reject larger windows with a specific error code so the CLI can re-encode.

**L8.** `tenant_session_current` write ordering (§6). State whether the row is written **in the same transaction** as `tenant_store_authority.current_receipt_id` swap, or asynchronously. If async, state the maximum consistency window and what the read API returns during the gap. The `search_generation_current` path is explicit ("in same authority transaction", line 762); `tenant_session_current` should match it or document the gap.

**L9.** `clientSignatureStatus='absent_v2_0'` sunset. Today this is a permanent enum value (line 343). If v2.1 makes device signatures mandatory, decide now whether `absent_v2_0` becomes `invalid_rejected` at a version boundary or remains valid forever. A permanent grandfather clause is fine; an undecided one becomes audit dead weight.

**L10.** Cross-tenant CAS dedup and timing oracle (§9 + §8). The closeout's pack model gives global object content addressing but tenant-scoped pack grants. Two questions: is the server allowed to dedup an object across tenants (one `remote_pack_entry`, two `receipt_pack_grant`s)? And does `MissingObjectPlanV2` leak a timing oracle that tells tenant B "I uploaded the same object as tenant A"? Pick a posture (full cross-tenant dedup with oracle accepted, or per-tenant-scoped packs with no cross-tenant sharing) and write it down.

**L11.** Pack GC ownership. When no `receipt_pack_grant` references a `remote_pack`, who deletes the row and the S3 bytes? `prosa-audit-worker` is described for hash verification (§13) but not for lifecycle GC. Either expand its scope or name a separate GC owner.

### `read-api-v2.md` must pin

**L12.** CLI cache-skip-network behavior (§10). The refresh contract returns `expiresAt` (line 449), but the spec doesn't explicitly state that the CLI **may skip the HTTP call when `checkedAt + TTL > now`.** Without that permission, every interactive CLI invocation issues a round-trip to Postgres, providing no amortization. State the rule.

**L13.** Per-page joint constraint on `SessionBlobPackV2`. The 32 KiB inline-block limit and the 1 MiB per-page uncompressed cap interact: 256 messages × 32 KiB = 8 MiB which exceeds the page cap. State the joint constraint as a single rule ("page payload <= max_page_uncompressed_bytes AND each inline block <= max_inline_block_bytes") and have the writer enforce both, falling back to CAS refs when inline would push the page over.

**L14.** Re-promotion trigger mechanism (§13). When a receipt becomes `degraded`, the audit worker "requests client re-promotion if any device with the receipt appears" (line 674). Specify the mechanism: a flag in `AuthorityRefreshResponse`, a push notification, or a pull the client discovers on next read. Pick one — without it, the degraded-receipt path is undefined operationally.

**L15.** Merkle input shape for the projection root (§16). The closeout asserts that physical Parquet compaction preserves `projectionRoot` because the root is over row content, not file bytes (line 803). The spec must pin the exact Merkle input: canonical CBOR-encoded row tuples sorted by primary key, hashed pairwise. Without this pin, an implementer who hashes file bytes will break the invariant on first compaction.

**L16.** `prosa tui` surface (§17, line 837). The mapping table leaves this as "`prosa read tui` or retained as `prosa tui`." Pick one before CLI implementation starts; two paths will diverge.

**L17.** Tantivy generation retirement (§15). State the rule for transitioning a generation from `'ready'` to `'retired'` and the deletion schedule for retired generation directories on Tantivy worker NVMe/EBS. Without bounded retention, frequent promotions exhaust worker storage.

## Operational considerations (non-blocking)

These are not gaps in the spec — they are operational realities the team should acknowledge when planning capacity and runbooks.

- **ClickHouse base + fixup coalescing.** A `ReplacingMergeTree` or `FINAL` qualifier on transcript reads is cheap when the fixup row count per session is in single digits, but degrades linearly. If a small set of long-lived sessions accumulates dozens of fixups, transcript-page latency drifts upward. A periodic "fold fixups into base" maintenance pass is cheap to add later; it does not need to ship at v2.0.
- **Streaming validation CPU.** At 4 concurrent pack validations per API worker × 100–200 ms each, an API fleet handling 100 concurrent uploads needs ~25 workers just for ingest CPU. The spec should include a sizing rule of thumb so operators size the fleet correctly.
- **Audit worker compute budget.** Weekly full-header scans and monthly full-byte rehashes are non-trivial. The audit worker is a separate process — give it its own ECS task / Kubernetes job rather than sharing API worker capacity.
- **CLI scriptability under the new surface.** The 1:1 mapping in §17 is sufficient for `--help` documentation, but a deprecation period with command aliases would smooth the transition for scripts that pipe `prosa search "X" | jq` today. This is a release-management decision, not a spec decision.
- **Cross-tenant CAS dedup vs privacy.** Whichever posture the team picks (L10), document it in user-facing terms because it affects compliance posture for tenants that consider their content sensitive.

## Recommendation

**Accept the closeout as the binding spec basis.** The architectural skeleton from proposal 1 plus the structural amendments in the closeout produces an implementable design. The remaining seventeen last-mile items (L1–L17) are correctly described as spec-freeze concerns, not architectural ambiguity.

Concrete next steps:

1. The proposer (or the implementation team) cuts three spec documents: `bundle-v2.md`, `promotion-protocol-v2.md`, `read-api-v2.md`. Each document pins the items listed against it above.
2. The spec freeze is the cutover gate. After freeze, implementation begins; before freeze, only spec edits are allowed.
3. Operational documents (sizing, audit cadence, capacity planning) live separately and can iterate post-freeze without requiring spec re-issue.

There is no further architecture review needed before the spec freeze. The remaining risk is now in implementation discipline — making the three specs internally consistent and ensuring two implementers in different subsystems do not make divergent assumptions about the same shared structure (e.g. the Merkle input rule, the zstd window cap, the consistency window of `tenant_session_current`).
