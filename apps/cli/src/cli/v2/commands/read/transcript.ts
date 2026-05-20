// Lane 7 — `prosa read transcript <session-id>`.
//
// Consumes `/v2/reads/sessions/transcript`. The response is either
// the full page (session + turns + unattachedToolCalls + nextCursor)
// or `null` when the session is not in the current authority.
//
// With `--all-pages` the CLI walks `nextCursor` to completion. A
// mid-walk 412 surfaces `AuthorityChangedError` so the operator can
// rerun rather than emit a transcript that mixes two snapshots.

import { formatTranscriptText, loadTranscript } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { withBundle } from '../../../bundle.js'
import { CliUserError } from '../../../errors.js'
import { AuthorityChangedError } from '../../authority/index.js'
import {
  AuthorityChangedHttpError,
  type TranscriptPageBody,
  type TranscriptToolCall,
  type TranscriptTurn,
} from '../../client/index.js'
import { type CommonReadOptions, addCommonReadOptions, prepareV2Read, with412RefreshAndRetry } from './common.js'

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
            throw new CliUserError(
              'prosa read transcript --format markdown is not supported in --authority local; use `prosa export session` for local markdown.',
            )
          }
          process.stdout.write(`${formatTranscriptText(transcript, { showThinking: false })}\n`)
        })
        return
      }

      const pages: TranscriptPageBody[] = []
      let cursor: string | null | undefined = options.cursor ?? null
      let currentCtx = ctx

      // CQ-152 behavior split:
      //  - Single-page transcript (no --all-pages) is an idempotent
      //    read; HTTP 412 triggers one authority refresh + retry via
      //    `with412RefreshAndRetry`. A second 412 stops with
      //    `AuthorityChangedError`.
      //  - Multi-page walk (--all-pages) MUST fail closed on any 412
      //    so partial output never mixes two receipt snapshots.
      do {
        let page: TranscriptPageBody | null
        if (options.allPages) {
          try {
            page = await currentCtx.client.getTranscriptPage({
              sessionId,
              ...(cursor ? { cursor } : {}),
              ...(limit ? { limit } : {}),
            })
          } catch (err) {
            if (err instanceof AuthorityChangedHttpError) {
              throw new AuthorityChangedError(
                'authority changed mid-transcript (HTTP 412); rerun the command to walk the new receipt.',
              )
            }
            throw err
          }
        } else {
          page = await with412RefreshAndRetry(currentCtx, (cur) => {
            if (cur.kind !== 'remote') throw new Error('expected remote context')
            currentCtx = cur
            return cur.client.getTranscriptPage({
              sessionId,
              ...(cursor ? { cursor } : {}),
              ...(limit ? { limit } : {}),
            })
          })
        }
        if (page === null) {
          if (pages.length === 0) {
            throw new CliUserError(`session ${sessionId} not found in the current authority.`)
          }
          break
        }
        pages.push(page)
        cursor = options.allPages ? page.nextCursor : null
      } while (cursor)

      if (format === 'json') {
        const merged =
          pages.length === 1
            ? pages[0]
            : {
                session: pages[0]?.session,
                turns: pages.flatMap((p) => p.turns),
                unattachedToolCalls: pages.flatMap((p) => p.unattachedToolCalls),
                nextCursor: pages[pages.length - 1]?.nextCursor ?? null,
              }
        process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`)
        return
      }

      const turns = pages.flatMap((p) => p.turns)
      const unattached = pages.flatMap((p) => p.unattachedToolCalls)
      process.stdout.write(renderTranscript(turns, unattached, format))
    })
  return cmd
}

function renderTranscript(
  turns: TranscriptTurn[],
  unattached: TranscriptToolCall[],
  format: 'text' | 'markdown',
): string {
  const lines: string[] = []
  for (const turn of turns) {
    if (format === 'markdown') {
      lines.push(`## ${turn.role}${turn.timestamp ? ` — ${turn.timestamp}` : ''}\n`)
    } else {
      lines.push(`[${turn.role}]${turn.timestamp ? ` ${turn.timestamp}` : ''}`)
    }
    for (const block of turn.blocks) {
      if (block.hidden) continue
      if (block.textInline) {
        lines.push(block.textInline)
      } else if (block.textObjectId) {
        lines.push(`<artifact ${block.blockType} object=${block.textObjectId}>`)
      }
    }
    for (const call of turn.toolCalls) {
      const status = call.result?.status ?? call.status ?? 'pending'
      const prefix = format === 'markdown' ? '- ' : '  '
      lines.push(`${prefix}tool ${call.toolName} status=${status}`)
    }
    lines.push('')
  }
  if (unattached.length > 0) {
    lines.push(format === 'markdown' ? '## unattached tool calls' : '[unattached tool calls]')
    for (const call of unattached) {
      const status = call.result?.status ?? call.status ?? 'pending'
      const prefix = format === 'markdown' ? '- ' : '  '
      lines.push(`${prefix}tool ${call.toolName} status=${status}`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
