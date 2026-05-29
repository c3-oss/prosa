import { defaultBundlePath, exportSessionMarkdown, formatTranscriptText, loadTranscript } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { withBundle } from '../bundle.js'
import { CliUserError } from '../errors.js'
import { renderTranscriptInk } from '../ink/transcript.js'

/** Output formats supported by `prosa v1 session show`. */
type SessionShowFormat = 'text' | 'markdown' | 'json'

function parseFormat(value: string): SessionShowFormat {
  if (value === 'text' || value === 'markdown' || value === 'json') return value
  throw new Error(`invalid format: ${value} (expected text|markdown|json)`)
}

function parseMaxLines(value: string): number {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`invalid --max-output-lines: ${value} (expected positive integer)`)
  }
  return n
}

/** Create the `prosa v1 session` command group with the `show` subcommand. */
export function sessionCommand(): Command {
  const show = new Command('show')
    .description('Render a session transcript in text, markdown, or JSON.')
    .argument('<session-id>', 'prosa session_id')
    .option('--format <fmt>', 'output format: text|markdown|json', 'text')
    .option('--show-thinking', 'render thinking/reasoning blocks in full', false)
    .option('--max-output-lines <n>', 'truncate tool outputs to N lines', '40')
    .option('--no-color', 'disable ANSI color even on a TTY')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
    .action(
      async (
        sessionId: string,
        options: {
          format: string
          showThinking: boolean
          maxOutputLines: string
          // commander negates --no-color into `color`
          color: boolean
          store: string
          local: boolean
        },
      ) => {
        const format = parseFormat(options.format)
        const maxOutputLines = parseMaxLines(options.maxOutputLines)

        // Remote authority is not implemented for transcript rendering yet
        // (Fase 4); fail-closed unless the store is local-authoritative.
        await resolveReadAuthorityOrFailClosed({
          commandName: 'prosa v1 session show',
          storePath: options.store,
          forceLocal: options.local,
          remoteSupported: false,
        })

        await withBundle(options.store, async (bundle) => {
          if (format === 'markdown') {
            const markdown = await exportSessionMarkdown(bundle, sessionId)
            process.stdout.write(markdown)
            return
          }

          const transcript = await loadTranscript(bundle, sessionId)
          if (!transcript) {
            throw new CliUserError(`session not found: ${sessionId}`)
          }

          if (format === 'json') {
            process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`)
            return
          }

          // Caller decides between Ink (interactive TTY, colored) and a plain
          // ANSI-free string (pipes, files, --no-color). --no-color always
          // wins; otherwise honor TTY detection so piped output stays clean.
          const wantsInk = options.color !== false && Boolean(process.stdout.isTTY)
          if (wantsInk) {
            await renderTranscriptInk(transcript, {
              showThinking: options.showThinking,
              maxOutputLines,
            })
            return
          }
          const rendered = formatTranscriptText(transcript, {
            showThinking: options.showThinking,
            maxOutputLines,
          })
          process.stdout.write(rendered)
        })
      },
    )

  return new Command('session')
    .description('Inspect a single session (use `prosa v1 sessions` to list).')
    .addCommand(show)
}
