// Local-bundle implementation of `prosa read export parquet`.
//
// The bundle already emits per-entity Parquet sidecars under
// `<bundleRoot>/epochs/<n>/projection/<entity>.parquet`. Export is
// just a directory copy into the operator's chosen destination; if
// the bundle has never been compiled or the Parquet sidecars were
// suppressed (`compile-v2 --no-build-derived` keeps NDJSON only —
// note that Parquet emission lives in the importers orchestrator
// and runs regardless), the copy step is a no-op.

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { loadBundleHead } from './head.js'

export type ExportParquetLocalOptions = {
  bundleRoot: string
  /** Destination directory; created if missing. */
  out: string
}

export type ExportParquetLocalResult = {
  bundleRoot: string
  destination: string
  epoch: number
  files: string[]
}

/**
 * Copy `<bundleRoot>/epochs/<head.epoch>/projection/*.parquet` into
 * `<out>/` and return the list of copied files. Throws when the
 * projection directory is missing or holds no Parquet siblings.
 */
export async function exportParquetLocal(options: ExportParquetLocalOptions): Promise<ExportParquetLocalResult> {
  const head = await loadBundleHead(options.bundleRoot)
  const projectionDir = join(options.bundleRoot, 'epochs', String(head.epoch), 'projection')
  let entries: string[]
  try {
    entries = await readdir(projectionDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`exportParquetLocal: ${projectionDir} not found; bundle has not been compiled`)
    }
    throw err
  }
  const parquetFiles = entries.filter((name) => name.endsWith('.parquet'))
  if (parquetFiles.length === 0) {
    throw new Error(`exportParquetLocal: ${projectionDir} has no .parquet siblings; was Parquet emission disabled?`)
  }
  await mkdir(options.out, { recursive: true })
  const copied: string[] = []
  for (const name of parquetFiles) {
    const from = join(projectionDir, name)
    const to = join(options.out, name)
    const st = await stat(from)
    if (!st.isFile()) continue
    await cp(from, to, { recursive: false })
    copied.push(to)
  }
  return {
    bundleRoot: options.bundleRoot,
    destination: options.out,
    epoch: head.epoch,
    files: copied,
  }
}
