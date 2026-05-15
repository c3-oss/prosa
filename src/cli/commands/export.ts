import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { defaultBundlePath } from '../../core/bundle.js'
import { exportSessionMarkdown } from '../../services/export/markdown.js'
import { exportBundleParquet } from '../../services/export/parquet.js'
import { asCliBundleOpenError, withBundle } from '../bundle.js'

/** Create the `prosa export` command group for session and Parquet exports. */
export function exportCommand(): Command {
  const session = new Command('session')
    .description('Export a single session to a human-readable format.')
    .argument('<session-id>', 'prosa session_id')
    .requiredOption('--format <fmt>', 'currently only "markdown" is supported')
    .option('--out <path>', 'write to file instead of stdout')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .action(async (sessionId: string, options: { format: string; out?: string; store: string }) => {
      if (options.format !== 'markdown') {
        throw new Error(`unsupported format: ${options.format} (try --format markdown)`)
      }
      await withBundle(options.store, async (bundle) => {
        const markdown = await exportSessionMarkdown(bundle, sessionId)
        if (options.out) {
          await writeFile(path.resolve(options.out), markdown, 'utf8')
          process.stdout.write(`wrote ${path.resolve(options.out)}\n`)
        } else {
          process.stdout.write(markdown)
        }
      })
    })

  const parquet = new Command('parquet')
    .description('Export canonical tables to derived Parquet files for analytics.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--out <path>', 'output directory (default: <store>/parquet)')
    .action(async (options: { store: string; out?: string }) => {
      const result = await exportBundleParquet({
        bundlePath: path.resolve(options.store),
        outDir: options.out ? path.resolve(options.out) : undefined,
      }).catch((error: unknown) => {
        throw asCliBundleOpenError(error)
      })
      process.stdout.write(`wrote parquet export to ${result.outDir}\n`)
      process.stdout.write(`manifest=${result.manifestPath}\n`)
    })

  return new Command('export')
    .description('Export sessions / search excerpts to readable formats.')
    .addCommand(session)
    .addCommand(parquet)
}
