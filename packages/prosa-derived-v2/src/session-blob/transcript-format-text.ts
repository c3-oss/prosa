// v2 transcript text renderer.
//
// Renders a `LoadedTranscriptFromBundle` (or a plain
// `TranscriptMessage[]`) as plain ASCII text suitable for piping
// to stdout, files, or a paginator. The format is deliberately
// flat — one section per message, prefixed with ordinal/role/
// timestamp/turn — so the output is easy to scan and easy to
// diff across runs. No ANSI escapes are emitted; callers that
// want colour can pipe through their own colouring tool.
//
// Pairs with `loadTranscriptFromBundle`: the canonical use case
// is the CLI `prosa index-v2 transcript --format text` flow that
// satisfies the JSON-form pair already shipped under
// `index-v2 transcript`.
//
// Block bodies are rendered as:
//
//   - `inline`: the literal `text` payload (multiline payloads
//     keep their newlines; downstream truncation lives in the
//     caller).
//   - `cas_ref`: a compact one-liner `object:<object_id>
//     bytes:<byte_length>` followed by the preview on the next
//     line if non-empty.
//
// Pure function — no filesystem, no native deps.

import type { TranscriptMessage } from './reader.js'
import type { LoadedTranscriptFromBundle } from './transcript-from-bundle.js'

export interface FormatTranscriptTextV2Options {
  /** When provided, lines headers include the per-pack metadata
   *  (epoch / pack_digest) instead of just session-scoped fields.
   *  Defaults to `false`. */
  includeHeader?: boolean
  /** When provided, only messages whose `ordinal` falls inside
   *  this inclusive range are rendered. */
  startOrdinal?: number
  /** Inclusive upper ordinal bound. */
  endOrdinal?: number
}

/**
 * Render a v2 transcript as plain text. Accepts either the
 * full `LoadedTranscriptFromBundle` (with epoch / pack_digest)
 * or just the `messages` array. With `includeHeader: true` (and
 * a loaded transcript input), the output begins with a
 * `session: …` / `epoch: …` / `pack: …` block followed by a
 * blank line; otherwise the messages are emitted directly.
 */
export function formatTranscriptTextV2(
  input: LoadedTranscriptFromBundle | TranscriptMessage[],
  options: FormatTranscriptTextV2Options = {},
): string {
  const messages = Array.isArray(input) ? input : input.messages
  const lines: string[] = []

  if (options.includeHeader && !Array.isArray(input)) {
    lines.push(`epoch:        ${input.epoch}`)
    lines.push(`pack_digest:  ${input.pack_digest}`)
    lines.push(`path:         ${input.path}`)
    lines.push(`message_count: ${messages.length}`)
    lines.push('')
  }

  const startOrdinal = options.startOrdinal ?? Number.NEGATIVE_INFINITY
  const endOrdinal = options.endOrdinal ?? Number.POSITIVE_INFINITY

  for (const message of messages) {
    if (message.ordinal < startOrdinal || message.ordinal > endOrdinal) continue
    const headerBits: string[] = [`[#${message.ordinal}]`, message.role]
    if (message.timestamp) headerBits.push(`@ ${message.timestamp}`)
    if (message.turn_id) headerBits.push(`(turn: ${message.turn_id})`)
    lines.push(headerBits.join(' '))
    for (const block of message.blocks) {
      const body = block.body
      if (body.kind === 'inline') {
        // Indent every line of the inline payload by 2 spaces so
        // multi-line inline blocks stay grouped with their header.
        const indented = body.text.length === 0 ? '' : indent(body.text, '  ')
        lines.push(`  ${block.block_id} | ${block.block_type} | inline (${body.byte_length} bytes)`)
        if (indented.length > 0) lines.push(indented)
      } else {
        // cas_ref
        const mime = body.mime_type ? ` mime:${body.mime_type}` : ''
        lines.push(
          `  ${block.block_id} | ${block.block_type} | cas_ref object:${body.object_id} bytes:${body.byte_length}${mime}`,
        )
        if (body.preview.length > 0) {
          lines.push(indent(body.preview, '    '))
        }
      }
    }
    lines.push('')
  }
  // Trim trailing blank line if the messages loop appended one.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}
