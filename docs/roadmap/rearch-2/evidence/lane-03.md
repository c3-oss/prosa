# Lane Evidence

Lane: 03 - Derived layer
Status: active WIP — scaffold + writer/compaction policies landed; Tantivy
writer, SessionBlobPackV2 byte layout, DuckDB analytics view definitions,
and the runtime compaction worker still pending.
Owner: Ralph
Commit range: Lane 3 scaffold lands on top of the Lane 2 `CQ-082` closeout
(`3eb1c08`) in a separate commit per `CQ-083`.

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
- [ ] Tantivy generation writer + incremental rebuild — pending.
- [ ] SessionBlobPackV2 byte layout (writer + reader emitting and
  parsing the actual `.prosa-session-blob` pack format) — pending.
- [ ] DuckDB analytics view definitions (5 fixed reports) — pending.
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
pnpm --filter @c3-oss/prosa-derived-v2 test         # 17 tests / 2 files (writer-policy 11, compaction 6)
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
