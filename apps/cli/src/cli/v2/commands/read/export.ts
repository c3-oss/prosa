// Lane 7 — `prosa read export parquet`.
//
// Local-only. Refreshes the analytics Parquet export from the local
// bundle. Fails closed for promoted stores until the operator runs
// the v2 importer locally; pointing analytics tools at stale
// Parquet would lie about the receipt-pinned authority surface.

import path from 'node:path'
import { exportParquetLocal } from '@c3-oss/prosa-derived-v2'
import { Command } from 'commander'
import { CliUserError } from '../../../errors.js'
import { type CommonReadOptions, addCommonReadOptions, prepareV2Read } from './common.js'

type ExportOptions = CommonReadOptions & {
  out?: string
}

export function readExportCommand(): Command {
  const cmd = new Command('export').description('Local-only export commands derived from the v2 bundle.')

  const parquet = new Command('parquet').description('Refresh Parquet analytics exports for the local bundle.')
  addCommonReadOptions(parquet)
  parquet
    .option('--out <path>', 'output directory (default: <store>/parquet)')
    .action(async (options: ExportOptions) => {
      const ctx = await prepareV2Read({ commandName: 'prosa read export parquet', options })
      if (ctx.kind !== 'local') {
        throw new CliUserError(
          'prosa read export parquet is local-only; rerun with --authority local against a local bundle.',
        )
      }
      const outDir = options.out ? path.resolve(options.out) : path.join(ctx.storePath, 'parquet')
      const result = await exportParquetLocal({ bundleRoot: ctx.storePath, out: outDir })
      process.stdout.write(`wrote parquet export to ${result.destination}\n`)
      process.stdout.write(`epoch=${result.epoch} files=${result.files.length}\n`)
    })

  cmd.addCommand(parquet)
  return cmd
}
