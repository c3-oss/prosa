// Lane 7 — `prosa read export parquet`.
//
// Local-only. Refreshes the analytics Parquet export from the local
// bundle. Fails closed for promoted stores until the operator runs
// the v2 importer locally; pointing analytics tools at stale
// Parquet would lie about the receipt-pinned authority surface.

import path from 'node:path'
import { exportBundleParquet } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { asCliBundleOpenError } from '../../../bundle.js'
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
      const result = await exportBundleParquet({
        bundlePath: ctx.storePath,
        outDir: options.out ? path.resolve(options.out) : undefined,
      }).catch((error: unknown) => {
        throw asCliBundleOpenError(error)
      })
      process.stdout.write(`wrote parquet export to ${result.outDir}\n`)
      process.stdout.write(`manifest=${result.manifestPath}\n`)
    })

  cmd.addCommand(parquet)
  return cmd
}
