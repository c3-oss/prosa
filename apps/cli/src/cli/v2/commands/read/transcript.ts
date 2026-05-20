// Lane 7 — `prosa read transcript <session-id>`.
//
// Consumes `/v2/reads/sessions/transcript` page by page. With
// `--all-pages` the CLI walks `nextCursor` to completion and
// concatenates the rendered output.  For streaming-output forms
// (text/markdown), a mid-walk 412 raises `AuthorityChangedError`
// rather than auto-refreshing — the operator must rerun with the
// fresh receipt.

import { formatTranscriptText, loadTranscript } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { withBundle } from '../../../bundle.js'
import { CliUserError } from '../../../errors.js'
import { AuthorityChangedError } from '../../authority/index.js'
import { AuthorityChangedHttpError, type TranscriptPageResponse, type TranscriptTurn } from '../../client/index.js'
import { type CommonReadOptions, addCommonReadOptions, prepareV2Read } from './common.js'

type TranscriptFormat = 'text' | 'markdown' | 'json'

function parseFormat(value: string): TranscriptFormat {
  if (value === 'text' || value === 'markdown' || value === 'json') return value
  throw new CliUserError(`invalid --format: ${value} (expected text|markdown|json)`)
}

type TranscriptOptions = CommonReadOptions & {
  format: string
  cursor?: string
  allPages: boolean
  limit?: string
}

export function readTranscriptCommand(): Command {
  const cmd = new Command('transcript')
    .description('Render a session transcript via the receipt-pinned v2 read API.')
    .argument('<session-id>', 'session id (v2 projection_session.id)')
  addCommonReadOptions(cmd)
  cmd
    .option('--format <fmt>', 'output format: text|markdown|json', 'text')
    .option('--cursor <token>', 'opaque page cursor from a prior response')
    .option('--all-pages', 'walk every page sequentially and concatenate output', false)
    .option('--limit <n>', 'page size (server-defaulted when omitted)')
    .action(async (sessionId: string, options: TranscriptOptions) => {
      const format = parseFormat(options.format)
      const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new CliUserError(`invalid --limit: ${options.limit}`)
      }

      const ctx = await prepareV2Read({ commandName: 'prosa read transcript', options })

      if (ctx.kind === 'local') {
        await withBundle(ctx.storePath, async (bundle) => {
          const transcript = await loadTranscript(bundle, sessionId)
          if (!transcript) {
            throw new CliUserError(`session ${sessionId} not found in local bundle.`)
          }
          if (format === 'json') {
            process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`)
            return
          }
          if (format === 'markdown') {
            // The local `exportSessionMarkdown` exists but expects an
            // output path; fall back to a JSON dump for now and let
            // the operator pipe through `prosa export session` for
            // markdown when running locally.
            throw new CliUserError(
              'prosa read transcript --format markdown is not supported in --authority local; use `prosa export session` for local markdown.',
            )
          }
          process.stdout.write(`${formatTranscriptText(transcript, { showThinking: false })}\n`)
        })
        return
      }

      const pages: TranscriptPageResponse[] = []
      let cursor: string | null | undefined = options.cursor ?? null

      do {
        let page: TranscriptPageResponse
        try {
          page = await ctx.client.getTranscriptPage({
            sessionId,
            ...(cursor ? { cursor } : {}),
            ...(limit ? { limit } : {}),
          })
        } catch (err) {
          if (err instanceof AuthorityChangedHttpError) {
            // The CLI refuses to silently switch receipts mid-walk —
            // the partial output would mix two snapshots. Surface the
            // signal and let the operator rerun.
            throw new AuthorityChangedError(
              'authority changed mid-transcript (HTTP 412); rerun the command to walk the new receipt.',
            )
          }
          throw err
        }
        pages.push(page)
        cursor = options.allPages ? page.nextCursor : null
      } while (cursor)

      if (format === 'json') {
        const merged =
          pages.length === 1
            ? pages[0]
            : {
                sessionId: pages[0]?.sessionId ?? sessionId,
                turns: pages.flatMap((p) => p.turns),
                nextCursor: pages[pages.length - 1]?.nextCursor ?? null,
              }
        process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`)
        return
      }

      const turns = pages.flatMap((p) => p.turns)
      process.stdout.write(renderTranscriptTurns(turns, format))
    })
  return cmd
}

function renderTranscriptTurns(turns: TranscriptTurn[], format: 'text' | 'markdown'): string {
  const lines: string[] = []
  for (const turn of turns) {
    if (format === 'markdown') {
      lines.push(`## ${turn.role}${turn.startedAt ? ` — ${turn.startedAt}` : ''}\n`)
    } else {
      lines.push(`[${turn.role}]${turn.startedAt ? ` ${turn.startedAt}` : ''}`)
    }
    for (const block of turn.blocks) {
      if (block.text) {
        lines.push(block.text)
      } else if (block.artifactRef?.bodyDigest) {
        lines.push(`<artifact ${block.artifactRef.bodyDigest}>`)
      }
    }
    for (const call of turn.toolCalls) {
      if (format === 'markdown') {
        lines.push(`- tool ${call.toolName ?? '(unknown)'} status=${call.result?.status ?? 'pending'}`)
      } else {
        lines.push(`  tool ${call.toolName ?? '(unknown)'} status=${call.result?.status ?? 'pending'}`)
      }
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
