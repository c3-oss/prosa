// Generic NDJSON segment streamer for `<bundleRoot>/epochs/<n>/projection/`.
//
// Every canonical projection segment follows the same on-disk shape:
// one JSON header line followed by one JSON row per line. The local
// read services iterate them with this helper rather than reaching
// for ad-hoc fs.read calls — that keeps the "skip header" trick in
// one place (the header is the only object with an `entityType`
// field, while entity rows do not carry one; this matches what the
// analytics runtime already does via DuckDB).
//
// The helper streams row objects via an async generator so callers
// process arbitrary entity counts without loading the entire segment
// into memory.

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export type ProjectionRow = Record<string, unknown>

/**
 * Resolve the absolute path of a projection segment by canonical entity
 * type. Mirrors what the bundle-v2 segment writer emits and what the
 * derived layer's session-blob / tantivy readers already glob.
 */
export function projectionSegmentPath(bundleRoot: string, epoch: number, entityType: string): string {
  return join(bundleRoot, 'epochs', String(epoch), 'projection', `${entityType}.prosa-projection.ndjson`)
}

/**
 * Stream rows from a single entity's projection segment. Yields one
 * object per row, skipping the canonical header line. Returns silently
 * when the segment file does not exist (the epoch simply has no rows
 * for that entity).
 */
export async function* iterateProjectionRows<T extends ProjectionRow = ProjectionRow>(
  bundleRoot: string,
  epoch: number,
  entityType: string,
): AsyncGenerator<T, void, void> {
  const segmentPath = projectionSegmentPath(bundleRoot, epoch, entityType)
  try {
    const st = await stat(segmentPath)
    if (!st.isFile()) return
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
  const rl = createInterface({
    input: createReadStream(segmentPath, { encoding: 'utf-8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let headerSeen = false
  try {
    for await (const raw of rl) {
      if (raw.length === 0) continue
      if (!headerSeen) {
        // Verify the first non-empty line parses; we don't enforce
        // shape — the bundle-v2 seal verifies the segment digest.
        try {
          JSON.parse(raw)
        } catch (err) {
          throw new Error(`iterateProjectionRows: ${segmentPath} header is not valid JSON: ${(err as Error).message}`)
        }
        headerSeen = true
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        throw new Error(`iterateProjectionRows: ${segmentPath} body line is not valid JSON: ${(err as Error).message}`)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      yield parsed as T
    }
  } finally {
    rl.close()
  }
}

/**
 * Collect every row from a single entity's projection segment into an
 * array. Convenience over `iterateProjectionRows` for callers that
 * need random access (e.g. joining tool_call with tool_result by id).
 */
export async function collectProjectionRows<T extends ProjectionRow = ProjectionRow>(
  bundleRoot: string,
  epoch: number,
  entityType: string,
): Promise<T[]> {
  const out: T[] = []
  for await (const row of iterateProjectionRows<T>(bundleRoot, epoch, entityType)) {
    out.push(row)
  }
  return out
}
