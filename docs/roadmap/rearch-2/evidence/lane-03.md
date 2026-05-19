# Lane Evidence

Lane: 03 - Derived layer
Status: active WIP — scaffold (`bb76006`) + SessionBlobPackV2 byte layout
(framing + writer + reader + verifier) landing in this iteration close
`CQ-084` and `CQ-085`. Tantivy writer, DuckDB analytics view definitions,
and the runtime compaction worker still pending.
Owner: Ralph
Commit range: Lane 3 scaffold (`bb76006`) + SessionBlobPackV2 byte-layout
slice (this iteration) on top of the Lane 2 `CQ-082` closeout (`3eb1c08`).

## Acceptance Criteria

- [x] `packages/prosa-derived-v2` scaffolded as a workspace package with
  `tsup` build, `vitest` test, Biome lint, and the standard `prosa-dev`
  source-condition export. Depends on `@c3-oss/prosa-bundle-v2` +
  `@c3-oss/prosa-types-v2`.
- [x] SessionBlobPackV2 joint-constraint policy implemented and tested:
  - `decideBlock(page, blockBytes)` returns `inline`, `cas_ref`
    (`oversize` / `page_would_be_empty`), or `split_page` per the lean
    profile caps (1 MiB page payload, 32 KiB per inline block, 256
    hard messages/page, 128 target messages/page).
  - `decideMessageBoundary(page)` returns `append` or `split_page`
    (`hard_message_cap` / `target_byte_budget`).
  - Simulated 5,000-small-message session paginates without
    overflowing either cap.
- [x] Compaction trigger policy implemented and tested:
  - `compactionDecision(segments)` fires on `file_count_trigger`
    when > 32 small segments exist, and on
    `low_count_byte_ceiling` when 17–32 small files weigh under
    256 MiB total. Large (≥ 32 MiB) segments are excluded from the
    "small" count.
- [x] Parquet compaction planner: `planCompaction(bundleRoot)` walks
  `epochs/<n>/projection/*.parquet`, groups segments per canonical
  entity name, applies `compactionDecision`, and emits a deterministic
  `CompactionPlan` naming exactly which segments would be merged into
  `epochs/compact-<NNNN>/projection/<entity>.compacted.parquet`.
  Already-compacted directories are skipped on re-run, sequence
  numbers auto-discover from existing `compact-NNNN/`, and
  non-numeric epoch entries are ignored. The actual row-preserving
  Parquet merge (runtime worker) still lands in a follow-up
  iteration when a Parquet writer is wired up.
- [ ] Tantivy generation writer + incremental rebuild — pending.
- [x] SessionBlobPackV2 byte layout (writer + reader emitting and
  parsing the actual pack format) implemented and tested:
  - 16-byte framing magic `PROSA_SESS_PACK2` mirroring the
    `prosa-bundle-v2` `PROSA_CAS_PACK_2` / `PROSA_RAW_SRC_V2`
    convention; canonical-JSON header bound by blake3.
  - `writeSessionBlobPack` paginates per the joint constraint,
    keeps multi-block messages atomic on a single page when they
    fit, and falls back to fragment mode for adversarial
    single-message-too-large inputs while preserving every block id.
  - `pack_digest` is defined as `blake3(canonical(header_without_pack_digest_field) || payload)`;
    `verifyPackDigest()` recomputes it from the bytes alone for
    tamper detection.
  - `loadTranscriptPage` validates both `stored_hash` (compressed)
    and `uncompressed_hash` before returning the parsed body.
  - Identity compressor/decompressor pair lets tests exercise the
    layout independently of zstd; production callers will plug in
    `zstdCompress` / `zstdDecompress` from `@c3-oss/prosa-bundle-v2`.
- [x] DuckDB analytics view definitions (5 fixed reports) — SQL
  bodies and column-shape contract land in
  `src/analytics/views.ts`. `ANALYTICS_VIEW_NAMES` /
  `ANALYTICS_VIEW_COLUMNS` lock the canonical names + ordered
  column lists; `analyticsViewSql(name)` returns the DuckDB
  `CREATE OR REPLACE VIEW ... AS ...` body; `parquetReadFor` and
  `analyticsParquetPreamble` build the Parquet-source temp views
  the runtime binds before executing the view bodies. Each body
  is a DuckDB port of the v1 statement: `julianday` → `EPOCH(::TIMESTAMP)`,
  `is_error = 1` → `is_error` boolean, `CAST(x AS TEXT)` removed
  where unnecessary. The runtime executor that actually opens a
  DuckDB connection and runs the SQL lands in a follow-up when
  `@duckdb/node-api` is wired into the package.
- [ ] Runtime Parquet compaction worker invoking the policy at the
  end of compile — pending.
- [ ] `prosa index-v2 tantivy`, `prosa index-v2 status`, and `prosa
  export-v2 parquet` CLI commands — pending Lane 7 surfaces but core
  functions land in this lane.

## Implementation Notes

- Source contract: `docs/rearch-2/04-lane-3-derived-layer.md`.
- The scaffold commit ships pure-TypeScript policy modules (no
  Tantivy or DuckDB dependencies yet). Subsequent iterations bring in
  `@oxdev03/node-tantivy-binding` and `@duckdb/node-api` mirroring
  the v1 derived layer's surface.
- `src/session-blob/writer-policy.ts` is deliberately a pure decision
  function so the actual pack writer (which streams CBOR + zstd
  output) can plug into it without rewriting the cap math.

## Commands Run

```text
pnpm install --prefer-offline                       # registers @c3-oss/prosa-derived-v2 in pnpm-lock.yaml
pnpm --filter @c3-oss/prosa-derived-v2 typecheck    # clean
pnpm --filter @c3-oss/prosa-derived-v2 test         # 55 tests / 6 files (writer-policy 11, compaction 6, framing 8, writer/reader 11, compaction planner 8, analytics views 11 — includes CQ-089 live + compacted Parquet overlay binding)
pnpm --filter @c3-oss/prosa-derived-v2 lint         # clean
pnpm build                                          # 13/13 turbo
pnpm typecheck                                      # 13/13 turbo
pnpm test                                           # 13/13 turbo
pnpm lint                                           # 13/13 turbo
pnpm test:conformance                               # 26 tests / 2 files (unchanged from Lane 2 closeout)
git diff --check                                    # clean
```

## Data / Security Evidence

- Derived artifacts are never authoritative; the lane-doc contract
  pins `bundleRoot` to row content (not file bytes) so compaction
  cannot mutate the canonical Merkle root.
- The writer-policy implementation never inlines a block larger than
  `MAX_INLINE_BLOCK_BYTES` and never emits a single-block page that
  exceeds `MAX_PAGE_UNCOMPRESSED_BYTES`; the 5,000-message
  simulation test enforces both caps after every commit.

## Known Risks

- Column drift in analytics and oversized transcript pages can break
  downstream CLI, MCP, and web reads. The joint-constraint test
  catches per-block oversize and per-page overflow; analytics column
  drift will be caught by snapshot fixtures when the view definitions
  land.

## Reviewer Notes

- Pending `prosa-cli-search-specialist` and `prosa-architect` review
  after the Tantivy writer + DuckDB views land. The scaffold is a
  pure-TypeScript foundation; further iterations bring native deps.
