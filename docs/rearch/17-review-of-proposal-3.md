# 17 — Review of proposal 3 (spec-freeze amendments)

A targeted review of the final v2 spec-freeze amendments. Each of the 17 last-mile items raised in doc 15 was evaluated for closure. Line numbers reference the amendments document unless stated otherwise.

## Verdict

**All 17 items close cleanly. Spec freeze is ready.** One micro-amendment to L15 (canonical timestamp truncation rule) is worth pinning in `read-api-v2.md` before code starts, but it is a one-sentence clarification, not an open question. The amendments document can serve as the source-of-truth annex to the three spec freezes; the proposer's recommendation to freeze and begin implementation is correct.

Three closures in this round are notably stronger than what the prior review asked for:

- **L3 (cold rebuild crash safety)** chose **scratch-and-rename** over resumable partial rebuild. This avoids checkpoint complexity entirely and trades it for repeated work after `SIGKILL` — a much better engineering trade than the alternative.
- **L8 (`tenant_session_current` consistency)** chose **a single Postgres transaction** for seal: receipt + authority + `tenant_session_current` + `search_generation_current` all commit together, with no async window. This is the simplest possible invariant for downstream code to depend on.
- **L14 (re-promotion trigger)** chose **pull-only discovery via `AuthorityRefreshResponse.repair`**, not push notifications. Keeps the v2.0 surface minimal and consistent with the existing refresh path the CLI already uses.

## Closure status of L1–L17

| # | Item | Closure | Quality |
|---|---|---|---|
| L1 | `SessionFixupV2` field set | `end_ts`, `model_last`, `parent_resolution` added; explicit propagation list to local hot cache, blob page headers, Postgres hot cache, `tenant_session_current`, ClickHouse coalescing view (lines 13–52). | Clean. The mandatory propagation list is the right enforcement mechanism. |
| L2 | Large-object pack assignment | `standalone_large_object: boolean` on `PackRef`; large objects are single-entry packs; the two large-object writers are concurrency limiters only, not poolers (lines 56–79). | Clean. |
| L3 | Cold rebuild crash safety | Scratch-and-rename via `index-rebuild-<uuid>/`; partial rebuilds detected on startup and deleted; no resumable partial state ever becomes authoritative (lines 80–110). | Clean and strictly safer than the alternative. |
| L4 | Per-logical-session `Reserve` | Explicit `ReserveSessionCommand`; importer flow requires cheap identification → reserve → only winner does full parse; Hermes/Gemini identification rules stated (lines 111–142). | Clean. |
| L5 | FK validation data structure | `EntityExistenceSet` = exact `HashSet` for current epoch + mmap-backed sorted fixed-key table for prior epochs; Bloom is acceleration only, never authority; no per-row RocksDB lookups (lines 144–167). | Clean. Avoids the 40–80 s seal pass risk. |
| L6 | `workspace_hint` propagation | Added to `SessionV2` and `ProjectV2`; `project_resolution` enum telegraphs which signal won; provenance preserved even when stronger signal wins (lines 168–202). | Clean. |
| L7 | Client zstd window cap | `maxZstdWindowBytes = 8 MiB`, `maxZstdWindowLog = 23`; wire-format rule, not server tuning; `PACK_ZSTD_WINDOW_TOO_LARGE` error with `action: 'reencode_pack'`; CLI catches and retries (lines 206–242). | Clean. Wire-format scope is exactly right. |
| L8 | `tenant_session_current` consistency | Single Postgres transaction: receipt + authority + `tenant_session_current` + `search_generation_current` + seal; no async window; failure leaves previous receipt authoritative (lines 244–272). | Clean and the simplest possible invariant. |
| L9 | `clientSignatureStatus='absent_v2_0'` sunset | v2.0 may mint absent; v2.1+ rejects with `CLIENT_SIGNATURE_REQUIRED`; old receipts remain verifiable forever and are not rewritten (lines 274–295). | Clean. |
| L10 | Cross-tenant CAS dedupe / oracle | No protocol-visible cross-tenant dedupe in v2.0; pack catalog tenant-scoped via `PRIMARY KEY (tenant_id, pack_digest)`; storage-layer dedupe allowed only if it does not alter protocol responses, timing, grants, or audit (lines 297–323). | Clean. Picks the conservative privacy posture. |
| L11 | Pack GC ownership | Separate `prosa-gc-worker`; `pack_gc_state` with five-status enum; eligibility rule (no sealed grant, no open promotion, no repair task, unreferenced ≥ 30 days); two-phase delete with 24 h tombstone (lines 325–376). | Clean. Three-way split (API / audit / GC) is the right operational shape. |
| L12 | CLI cache-skip-network rule | Within TTL and absent `--refresh`/mutating command, CLI uses cached authority without network call; defaults per mode stated (lines 380–405). | Clean. |
| L13 | `SessionBlobPackV2` joint page constraint | Joint constraint: page payload ≤ 1 MiB AND each inline block ≤ 32 KiB; byte cap wins over message count; writer algorithm explicit (lines 407–441). | Clean. |
| L14 | Re-promotion trigger | Pull-only discovery via `AuthorityRefreshResponse.repair`; `RepairRequest.kind = 're_promote_requested'` with reason enum; no push notification path for v2.0 (lines 443–496). | Clean and minimal. |
| L15 | Merkle input shape | Leaf = `blake3('prosa.projection.leaf.v2' \|\| entity_type \|\| primary_key \|\| canonical_cbor(row_tuple))`; canonical CBOR rules stated; sort order pinned; binary Merkle (lines 498–539). | Clean **except** for one timestamp-precision sub-rule — see micro-amendment below. |
| L16 | `prosa tui` surface | Retained top-level; `prosa read tui` not introduced; backed by the same `ReadContext` resolver (lines 541–559). | Clean. |
| L17 | Tantivy generation retirement | `search_generation_ref` with `ref_kind` enum; `ready→retired` after 7 days when not current and a newer ready generation exists; `retired→deleted` after 24 h grace; worker reload+drain protocol stated (lines 561–610). | Clean. |

## Strong commendations on specific decisions

- **Scratch-and-rename rebuild (L3)** is the right way to make repair safe. Resumable partial rebuilds are a class of bug that the design now cannot have at all.
- **Pack tenant-scoping (L10)** trades some storage efficiency for a sharp privacy boundary. Two tenants uploading identical content occupy separate catalog rows; the server may dedupe at the storage layer if and only if no protocol surface (response timing, grant resolution, audit) reflects it. This is the correct cut.
- **Separation of audit and GC workers (L11)** prevents two long-running batch jobs from competing for the same compute budget. Audit verifies integrity; GC reclaims storage. Different cadences, different failure modes, different capacity planning.
- **`project_resolution` enum on `SessionV2` (L6)** telegraphs which signal won the project association (`explicit_provider_project` / `workspace_hint` / `cwd_initial` / `path_inferred` / `unresolved`). Costs one column; saves hours of confused debugging.
- **Single-transaction seal (L8)** removes an entire class of "what does a reader see during materialization" questions. Either the new receipt is fully visible, or the previous receipt remains authoritative. No middle state ever leaks.

## One micro-amendment before freeze

### L15 — canonical timestamp precision rule

The Merkle leaf rule (line 520) states: *"Timestamps are UTC RFC3339 with millisecond precision."* This is sufficient when source data already arrives at millisecond precision, but some providers emit microsecond or nanosecond timestamps. Two implementers might handle the precision reduction differently — one truncating, one rounding — and produce divergent Merkle leaves for the same logical row.

**Pin:** add to `read-api-v2.md` §L15:

> Timestamps with sub-millisecond precision are **truncated** (not rounded) toward the epoch when canonicalized. The canonical form is `YYYY-MM-DDTHH:MM:SS.sssZ` with exactly three fractional-second digits. Timestamps with no fractional part are canonicalized as `YYYY-MM-DDTHH:MM:SS.000Z`.

This is one sentence. Without it, the projection root invariant — and therefore the receipt's correctness — depends on implementer agreement that the spec currently does not force.

No other item in L1–L17 has a similar latent ambiguity that survived the closeout.

## Final recommendation

**Freeze `bundle-v2.md`, `promotion-protocol-v2.md`, and `read-api-v2.md` with these amendments and the one micro-amendment above. Begin implementation.**

The architecture review thread is closed. The remaining risk is implementation discipline:

- Two implementers working on different subsystems must produce the same Merkle leaf for the same logical row (L15 + the precision rule).
- The pack writer must reject zstd frames with `window_size > 8 MiB` at ingest, and the CLI must catch `PACK_ZSTD_WINDOW_TOO_LARGE` and re-encode (L7).
- The seal transaction must be the only path that updates `tenant_session_current`; any background-job path that mutates it is a correctness bug (L8).
- The cold rebuild must never write into the live `index/` directory; any code that does is a correctness bug (L3).

These four properties are the load-bearing invariants of the implementation phase. Everything else is mechanical.

The five product invariants from the original handoff — raw byte preservation, idempotent re-imports, canonical cross-provider graph, content-addressed dedup, signed promotion receipts — all hold in the frozen design. The three target pipelines (compile, sync, query) all have implementable paths to the performance envelope in §10 of the original handoff.

No further architecture review is needed before code begins.
