// Per-entity Parquet sibling for the canonical NDJSON projection segments.
//
// `writeProjectionSegment` (in prosa-bundle-v2) writes the canonical
// NDJSON projection segment that the bundle's signed manifest hashes.
// The analytics runtime already reads those NDJSON files via DuckDB's
// `read_json_auto`, but Parquet is a much faster scan target for
// per-column work, so the orchestrator emits a sibling
// `<entity>.parquet` next to every NDJSON it writes.
//
// The Parquet is derived from the same NDJSON file (filter out the
// canonical header line by `entityType IS NULL` — the same trick the
// analytics runtime already uses). Two callers running on the same
// NDJSON input produce byte-equivalent rows (column order is fixed,
// per-row data is identical), so the Parquet is reproducible from
// the manifest content.
//
// Failures are non-fatal for the bundle: a sealed bundle stays
// readable even without the Parquet siblings. The orchestrator logs
// and continues so a DuckDB load failure on a thin worker doesn't
// brick `compile-v2`.

import { join } from 'node:path'

import {
  type CanonicalEntityType,
  ENTITY_FIELD_KINDS,
  type FieldKind,
  computeObjectId,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import type { DurableSegmentRef } from '@c3-oss/prosa-bundle-v2'

/**
 * Map prosa-types-v2 `FieldKind` to the DuckDB type that should back
 * the corresponding Parquet column. Pinning a type here keeps the
 * Parquet schema deterministic across runs — read_json_auto picks
 * VARCHAR when a column is entirely null, and that VARCHAR carries
 * through into the Parquet, which then breaks downstream aggregates
 * like `SUM(COALESCE(duration_ms, 0))` because the column is no
 * longer numeric.
 */
function duckdbTypeFor(kind: FieldKind): string {
  switch (kind) {
    case 'integer':
      return 'BIGINT'
    case 'boolean':
      return 'BOOLEAN'
    default:
      return 'VARCHAR'
  }
}

export type WriteProjectionParquetInput = {
  entityType: CanonicalEntityType
  /** Absolute path to the canonical NDJSON segment (`<entity>.prosa-projection.ndjson`). */
  ndjsonPath: string
  /** Directory the Parquet sibling lands in (usually the same `projection/` directory). */
  outDir: string
}

export type WriteProjectionParquetResult = {
  ref: DurableSegmentRef
  /** Absolute path to the emitted Parquet file. */
  path: string
}

/**
 * Convert a canonical NDJSON projection segment to a `projection_parquet`
 * sibling. Uses DuckDB's `COPY (...) TO ... (FORMAT PARQUET)` so the
 * runtime doesn't have to round-trip rows through JS.
 */
export async function writeProjectionParquet(
  input: WriteProjectionParquetInput,
): Promise<WriteProjectionParquetResult> {
  // Lazy import keeps `@duckdb/node-api` out of the workspace
  // typecheck graph until the orchestrator actually calls this; it
  // also defers the native binding load until the seal step runs.
  const duckdb = await import('@duckdb/node-api')
  const instance = await duckdb.DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  const parquetPath = join(input.outDir, `${input.entityType}.parquet`)
  // SQL string escaping: DuckDB single-quote literals double a single quote.
  const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`
  // Per-column TRY_CAST keeps the Parquet schema deterministic even
  // when a column is entirely null in this epoch (read_json_auto
  // would otherwise pick VARCHAR / JSON and the analytics view's
  // SUM/COALESCE on `duration_ms` etc. would fail at bind time).
  const fields = ENTITY_FIELD_KINDS[input.entityType]
  const columnProjection =
    fields !== undefined
      ? Object.entries(fields)
          .map(([name, kind]) => `TRY_CAST(${name} AS ${duckdbTypeFor(kind)}) AS ${name}`)
          .join(', ')
      : '*'
  const copy = `COPY (SELECT ${columnProjection} FROM read_json_auto(${sqlString(
    input.ndjsonPath,
  )}, format='newline_delimited', union_by_name=true) WHERE entityType IS NULL) TO ${sqlString(
    parquetPath,
  )} (FORMAT PARQUET, COMPRESSION 'zstd')`
  try {
    await connection.run(copy)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
  const { readFile } = await import('node:fs/promises')
  const bytes = new Uint8Array(await readFile(parquetPath))
  const digest = `blake3:${toHex(blake3(bytes))}`
  // computeObjectId is referenced to keep the import warm with the
  // helper the orchestrator uses elsewhere; the actual digest comes
  // from blake3 over the on-disk bytes for parity with the NDJSON
  // sibling's digest calculation.
  void computeObjectId
  const ref: DurableSegmentRef = {
    kind: 'projection_parquet',
    path: parquetPath,
    digest,
    byteLength: bytes.length,
    entityType: input.entityType,
  }
  return { ref, path: parquetPath }
}
