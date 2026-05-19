# Lane 3 Evidence — Derived layer

Updated: 2026-05-19 after cycle reset.

## Status

Active / incomplete. The support foundation is broad, but the runtime executors are still missing.

## Completed support foundation

- `packages/prosa-derived-v2` package scaffold and exports.
- SessionBlobPackV2:
  - writer/reader and byte-layout policy;
  - zstd codec;
  - path resolver and on-disk loader;
  - latest/current/historical transcript loaders;
  - listing, summary, exists, header, latest-epoch helpers;
  - read-side integration tests.
- Parquet/compaction support:
  - compaction policy and planner;
  - execution-plan composer;
  - projection segment listing/summary;
  - compact manifest build/read/write/deep validation;
  - superseded/compacted outputs helpers;
  - GC plan and GC execution-plan composers;
  - compaction effectiveness/history/overlap audit helpers.
- DuckDB analytics support:
  - fixed analytics view definitions;
  - pure execution-plan composer.
- Tantivy support:
  - schema/fingerprint;
  - rebuild planner/state machine;
  - checkpoint persistence;
  - index-dir probe/reset;
  - read-only status snapshot.
- Operational/read surfaces:
  - `bundleDerivedStatus`, `derivedLayerMaintenanceSummary`, `recommendMaintenanceActions`, `derivedLayerFootprint`, `derivedLayerCapabilities`, `derivedLayerSnapshot`.
  - `prosa index-v2` read/audit subcommands in `apps/cli/src/cli/commands/index-v2.ts`.

## Required next implementation

- [ ] Tantivy native writer / incremental rebuild runtime.
- [ ] DuckDB analytics runtime executor.
- [ ] Parquet compaction merge worker.
- [ ] End-to-end Lane 3 gates in `gates.md`.

## Deviation from original plan

The original Lane 3 plan required three runtime outputs: Tantivy writer, SessionBlob packs, DuckDB analytics over Parquet, plus compaction. The overnight loop implemented much more read/audit/CLI support than strictly required at this point, including several surfaces that conceptually belong to Lane 7 (CLI/MCP) or Lane 8 (audit/GC). Keep that work, but treat it as supporting infrastructure rather than completion evidence for the missing runtime executors.

## Current risk

The next loop may continue adding safe read-only utilities instead of tackling the runtime executor work. The next prompt explicitly forbids additional read/audit surfaces unless they directly support a selected runtime executor slice.
