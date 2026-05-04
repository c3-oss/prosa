# Search Indexing and Import Performance

## Context

The current `prosa` search layer uses SQLite FTS5 over `search_docs`. In the
current local store, this is already fast enough for CLI and human-scale use:
queries over roughly hundreds of thousands of indexed documents return in
tens of milliseconds for common terms.

However, the intended operating model for `prosa` includes multiple agents
querying the same store concurrently, especially through MCP and future TUI
surfaces. That changes the tradeoff: raw FTS5 latency is not the only concern.
Concurrent reads, richer ranking, typo tolerance, and snippet quality matter
more.

## Tantivy Evaluation

Tantivy is worth considering as a derived sidecar index, not as a replacement
for the canonical SQLite store.

Recommended shape:

```text
~/.prosa/
  prosa.sqlite          # canonical catalog
  objects/              # preserved raw bytes and large objects
  search/
    tantivy/            # derived full-text index
```

Tantivy would be useful for:

- fuzzy search and typo tolerance;
- better stemming/tokenization;
- stronger ranking than basic FTS5 BM25;
- higher-quality snippets over many results;
- heavier concurrent search workloads from MCP/TUI/agents;
- asynchronous rebuilds without changing canonical data.

SQLite FTS5 should remain as the simple default and fallback. Tantivy should be
introduced as an optional derived engine:

```bash
prosa index tantivy
prosa search "terrafom paln" --engine tantivy
prosa mcp serve --search-engine tantivy
```

## Import Performance

Tantivy is not the primary fix for faster imports. Import performance should be
optimized by separating ingestion from indexing.

The current schema uses FTS5 triggers on `search_docs`, which is simple and
correct but can make large imports more expensive because every inserted search
document updates the full-text index immediately.

A faster pipeline should allow:

```text
compile:
  preserve raw bytes
  normalize SQLite projections
  write search_docs
  optionally defer text indexing

index:
  rebuild FTS5 or Tantivy from search_docs
```

Likely import optimizations:

- profile real imports to find whether time is spent in parsing, SQLite writes,
  CAS hashing, zstd compression, or FTS triggers;
- add `prosa compile --defer-index`;
- add `prosa index fts5` to rebuild SQLite FTS after bulk import;
- add `prosa index tantivy` as a separate sidecar build;
- batch SQLite inserts and reduce repeated object writes;
- parallelize by source file or source tool only after idempotency remains clear.

## Conclusion

Tantivy is interesting for concurrent, higher-quality search. It should be
added when `prosa` needs fuzzy search, better ranking/snippets, or agent-heavy
parallel reads.

For faster imports, the first architectural move should be to decouple import
from indexing. Keep SQLite/CAS as the source of truth, keep FTS5 as the default
MVP search path, and add Tantivy as an optional derived index once the indexing
pipeline is explicit.
