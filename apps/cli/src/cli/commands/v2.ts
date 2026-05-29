import { Command } from 'commander'
import { mcpV2Command } from '../v2/commands/mcp-serve.js'
import { readCommand } from '../v2/commands/read/index.js'
import { bundleCommand } from './bundle.js'
import { compileAllV2Command, compileV2Command } from './compile-v2.js'
import { indexV2Command } from './index-v2.js'
import { migrateV2Command } from './migrate-v2.js'
import { syncV2Command } from './sync-v2.js'

/** Group `prosa v2 <command>` — the bundle-v2 (NDJSON + Parquet) surface. */
export function v2Command(): Command {
  const command = new Command('v2').description('Bundle v2 (NDJSON + Parquet) prosa surface.').enablePositionalOptions()

  command.addCommand(compileV2Command())
  command.addCommand(compileAllV2Command())
  command.addCommand(indexV2Command())
  command.addCommand(syncV2Command())
  command.addCommand(bundleCommand())
  command.addCommand(readCommand())
  command.addCommand(mcpV2Command())
  command.addCommand(migrateV2Command())

  command.action(() => {
    command.help({ error: true })
  })

  return command
}
