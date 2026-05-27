// `prosa bundle` — Lane 1 v2 bundle administration commands.
//
// First subcommand: `rebuild-index`. Walks every sealed epoch under
// `<store>/epochs/`, re-derives per-shard logs from canonical projection
// segments, and atomically swaps `index/` to the new content. The old
// `index/` is archived as `index-old-<timestamp>/`. The implementation
// lives in `@c3-oss/prosa-bundle-v2/src/rebuild/index.ts`; this command
// is the operator-facing surface that the Lane 1 contract names.

import path from 'node:path'

import { openBundle, rebuildIndex } from '@c3-oss/prosa-bundle-v2'
import { Command } from 'commander'

export function bundleCommand(): Command {
  const cmd = new Command('bundle').description('Bundle v2 administration commands.')

  cmd
    .command('rebuild-index')
    .description('Reconstruct the per-shard index from sealed epoch projections.')
    .requiredOption('--store <path>', 'bundle directory')
    .option('--uuid <uuid>', 'override the scratch UUID (used for deterministic tests)')
    .action(async (options: { store: string; uuid?: string }) => {
      const resolved = path.resolve(options.store)
      const bundle = await openBundle(resolved)
      try {
        const result = await rebuildIndex(bundle, options.uuid ? { uuid: options.uuid } : {})
        process.stdout.write(
          `${JSON.stringify(
            {
              rebuiltAt: result.manifest.rebuiltAt,
              uuid: result.manifest.uuid,
              storeId: result.manifest.storeId,
              epochsWalked: result.manifest.epochsWalked,
              shardCount: result.manifest.shardCount,
              totalRowsByKeyspace: result.manifest.totalRowsByKeyspace,
              perShardCounts: result.manifest.perShardCounts,
              newIndexDir: result.newIndexDir,
              archivedAt: result.archivedAt,
            },
            null,
            2,
          )}\n`,
        )
      } finally {
        await bundle.close()
      }
    })

  return cmd
}
