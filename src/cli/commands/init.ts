import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import { closeBundle, defaultBundlePath, initBundle, openBundle } from '../../core/bundle.js'

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize a new prosa bundle (SQLite + manifest + objects/).')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--force-existing', 'open instead of failing if a manifest exists', false)
    .action(async (options: { store: string; forceExisting: boolean }) => {
      const resolved = path.resolve(options.store)
      const exists = await stat(`${resolved}/manifest.json`)
        .then(() => true)
        .catch(() => false)

      if (exists) {
        if (!options.forceExisting) {
          process.stderr.write(
            `bundle already initialized at ${resolved}\nuse --force-existing to skip without erroring\n`,
          )
          process.exit(2)
        }
        const bundle = await openBundle(resolved)
        closeBundle(bundle)
        process.stdout.write(`bundle already exists at ${resolved}\n`)
        return
      }

      const bundle = await initBundle(resolved)
      closeBundle(bundle)
      process.stdout.write(`initialized prosa bundle at ${resolved}\n`)
    })
}
