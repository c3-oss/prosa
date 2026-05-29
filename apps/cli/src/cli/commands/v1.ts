import { Command } from 'commander'
import { analyticsCommand } from './analytics.js'
import { compileAllCommand, compileCommand } from './compile.js'
import { doctorCommand } from './doctor.js'
import { exportCommand } from './export.js'
import { indexCommand } from './index.js'
import { initCommand } from './init.js'
import { mcpCommand } from './mcp.js'
import { queryCommand } from './query.js'
import { searchCommand } from './search.js'
import { sessionCommand } from './session.js'
import { sessionsCommand } from './sessions.js'
import { syncCommand } from './sync.js'
import { tuiCommand } from './tui.js'

/** Group `prosa v1 <command>` — the legacy SQLite-backed surface. */
export function v1Command(): Command {
  const command = new Command('v1')
    .description('Legacy SQLite-backed prosa surface (bundle v1).')
    .enablePositionalOptions()

  command.addCommand(initCommand())
  command.addCommand(compileCommand())
  command.addCommand(compileAllCommand())
  command.addCommand(indexCommand())
  command.addCommand(sessionsCommand())
  command.addCommand(sessionCommand())
  command.addCommand(searchCommand())
  command.addCommand(exportCommand())
  command.addCommand(queryCommand())
  command.addCommand(analyticsCommand())
  command.addCommand(doctorCommand())
  command.addCommand(mcpCommand())
  command.addCommand(tuiCommand())
  command.addCommand(syncCommand())

  command.action(() => {
    command.help({ error: true })
  })

  return command
}
