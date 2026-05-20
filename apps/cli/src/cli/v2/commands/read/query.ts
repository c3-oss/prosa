// Lane 7 — `prosa read query '<sql>' [--engine duckdb]`.
//
// Local-only by contract. The CLI fails closed when the resolved
// authority is remote: ad-hoc DuckDB queries operate on the
// exported Parquet directory which only lives next to a local
// bundle. Operators on a promoted store must run the v2 importer
// + parquet export locally to refresh the analytics surface.

import path from 'node:path'
import { queryDuckDbParquet } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { withBundle } from '../../../bundle.js'
import { CliUserError } from '../../../errors.js'
import { printRows } from '../../../output.js'
import { type CommonReadOptions, addCommonReadOptions, parseOutputFormat, prepareV2Read } from './common.js'

type QueryOptions = CommonReadOptions & {
  engine: string
  parquetDir?: string
  outputFormat: string
}

export function readQueryCommand(): Command {
  const cmd = new Command('query')
    .description('Run an ad-hoc analytical query over the local Parquet export (local-only).')
    .argument('<sql>', 'DuckDB SQL query')
  addCommonReadOptions(cmd)
  cmd
    .option('--engine <name>', 'analytics engine (only duckdb is supported)', 'duckdb')
    .option('--parquet-dir <path>', 'Parquet directory (default: <store>/parquet)')
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(async (sql: string, options: QueryOptions) => {
      if (options.engine !== 'duckdb') {
        throw new CliUserError(`unsupported --engine: ${options.engine} (only duckdb is supported)`)
      }
      const format = parseOutputFormat(options.outputFormat, 'table')

      const ctx = await prepareV2Read({ commandName: 'prosa read query', options })
      if (ctx.kind !== 'local') {
        throw new CliUserError(
          'prosa read query is local-only; rerun with --authority local against a local bundle, or refresh the Parquet export.',
        )
      }

      const parquetDir = options.parquetDir
        ? path.resolve(options.parquetDir)
        : await withBundle(ctx.storePath, (bundle) => bundle.paths.parquet)

      const result = await queryDuckDbParquet({ parquetDir, sql })
      printRows(result.rows, {
        format,
        columns: result.columns,
        meta: { query: sql, count: result.rows.length, source: 'local-parquet' },
      })
    })
  return cmd
}
