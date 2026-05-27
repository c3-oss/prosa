// Lane 7 — `prosa read` command group.
import { Command } from 'commander'
import { readAnalyticsCommand } from './analytics.js'
import { readExportCommand } from './export.js'
import { readQueryCommand } from './query.js'
import { readSearchCommand } from './search.js'
import { readSessionsCommand } from './sessions.js'
import { readToolCallsCommand } from './tool-calls.js'
import { readTranscriptCommand } from './transcript.js'

export function readCommand(): Command {
  const command = new Command('read').description('Receipt-pinned read commands backed by the v2 read API.')
  command.addCommand(readSessionsCommand())
  command.addCommand(readTranscriptCommand())
  command.addCommand(readSearchCommand())
  command.addCommand(readToolCallsCommand())
  command.addCommand(readAnalyticsCommand())
  command.addCommand(readQueryCommand())
  command.addCommand(readExportCommand())
  return command
}
