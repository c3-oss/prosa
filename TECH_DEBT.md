# Technical debt

Things we know are not ideal but chose to live with, with enough
context to revisit them later. Each entry should answer: what is it,
where it lives, why it is the way it is, and what a real fix would
look like.

---

## Postgres `tsvector` 1 MiB ceiling

**Where:** `migrations/server/0003_turns_tsvector_cap.up.sql` —
`turns.content_tsv` is `GENERATED ALWAYS AS to_tsvector('simple',
left(content, 800000)) STORED`.

**What:** the GENERATED column truncates its input at 800 KB before
feeding it to `to_tsvector`. The underlying `turns.content` field
stays untouched (full body preserved). The remote FTS (`prosa search
--remote`) therefore stops covering anything past the first ~800 KB
of any single turn.

**Why we did it:** Postgres' `tsvector` type rejects any single
document above 1 MiB with `string is too long for tsvector (N bytes,
max 1048575 bytes)`. The limit is **hardcoded into the type itself**,
not behind a GUC, not behind a build flag, not configurable
per-table. It comes from the `varlena` layout that backs `tsvector`:
the offsets stored alongside each lexeme cap the total
serialized-on-disk size at `MAXSTRPOS = 0x100000 - 1`. Changing it
requires patching the Postgres source and recompiling — completely
out of reach for any hosted instance and a non-starter for self-host
too.

This bit us during the first full validation of Group B: 2 of the
2 814 real sessions on the dev machine had assistant turns above the
ceiling (one 5.5 MiB tool output, one 1.3 MiB paste-in), and their
Push failed mid-transaction. The S3 raw upload succeeded, but the
Postgres metadata tx rolled back. The reconcile diffed and re-tried
forever.

Capping at 800 KB leaves ~200 KB of headroom for the tsvector's own
overhead (token offsets + per-lexeme metadata typically inflate the
stored size by 20–30%) and unblocks all known production sessions
without losing the body itself.

**Trade-off:** for the two oversize turns, search will only match
terms that appear in their first 800 KB. The full content remains
visible in `Get`, `prosa show`, and the future panel — only ranking
and snippet generation miss the tail.

**Better fixes if/when they become worth it:**

1. **Chunk the turn into multiple FTS rows.** Create a sibling table
   `turn_chunks(turn_id, chunk_idx, content, content_tsv)` and write
   one row per ~800 KB slice. Search becomes a JOIN over chunks; rank
   aggregation needs care (a single GIN scan per chunk and then
   `max(ts_rank)` per turn). Adds complexity; only worth it if real
   users start losing matches we know matter.
2. **Switch off Postgres FTS for "huge" turns.** Add an
   `is_oversize boolean` column; `content_tsv` becomes NULL for those
   rows and they don't participate in `Search`. Simpler than chunking
   but admits "your message is too big to find" as a product reality
   — the panel would need to surface that.
3. **Move FTS out of Postgres.** Plug in a dedicated search engine
   (Tantivy via `pg_search`, Meilisearch, OpenSearch). Removes the
   ceiling entirely, costs an extra service to operate. Only makes
   sense once the panel needs ranking / faceting beyond `tsvector`
   can give us anyway.
4. **Truncate client-side before push.** Strictly worse than the
   current server-side cap because it loses the raw content too,
   defeating the purpose of preserving the JSONL verbatim. Avoid.

Until one of those becomes worth the work, the 800 KB cap stays.
