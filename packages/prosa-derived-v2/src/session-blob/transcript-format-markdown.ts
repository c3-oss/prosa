// v2 transcript Markdown renderer.
//
// Renders a `LoadedTranscriptFromBundle` (or a plain
// `TranscriptMessage[]`) as Markdown. Pairs with the JSON-form
// (`transcript`) and the text-form (`formatTranscriptTextV2`)
// renderers. Markdown is the format users typically paste into a
// PR description, a Notion/Outline page, or a chat — the goal is
// a clean, deterministic rendering that respects the input shape
// without inventing structure that is not in the underlying
// `TranscriptMessage[]`.
//
// Format conventions:
//
//   - With `includeHeader: true` (and a `LoadedTranscriptFromBundle`
//     input), the document opens with a `# Transcript` heading and
//     a bulleted metadata list (epoch / pack_digest / path /
//     message_count), separated from the body by an `---` rule.
//   - Each message becomes an `## #<ordinal> — <role>` heading,
//     followed by a metadata line (timestamp + turn) and one
//     section per block.
//   - Inline text blocks render as a fenced code block when the
//     payload spans multiple lines or contains backticks; single-
//     line plain text is emitted as a regular paragraph for
//     readability.
//   - `cas_ref` blocks render as a blockquote with the object id,
//     byte length, optional mime type, and an indented preview
//     code block.
//
// Pure function — no filesystem, no native deps.

import type { TranscriptMessage } from './reader.js'
import type { LoadedTranscriptFromBundle } from './transcript-from-bundle.js'

export interface FormatTranscriptMarkdownV2Options {
  /** When `true`, emit the pack-level metadata header. Requires
   *  a `LoadedTranscriptFromBundle` input. Defaults to `false`. */
  includeHeader?: boolean
  /** Inclusive lower ordinal bound. */
  startOrdinal?: number
  /** Inclusive upper ordinal bound. */
  endOrdinal?: number
}

/** Render a v2 transcript as Markdown. */
export function formatTranscriptMarkdownV2(
  input: LoadedTranscriptFromBundle | TranscriptMessage[],
  options: FormatTranscriptMarkdownV2Options = {},
): string {
  const messages = Array.isArray(input) ? input : input.messages
  const out: string[] = []

  if (options.includeHeader && !Array.isArray(input)) {
    out.push('# Transcript')
    out.push('')
    out.push(`- **epoch**: ${input.epoch}`)
    out.push(`- **pack_digest**: \`${input.pack_digest}\``)
    out.push(`- **path**: \`${input.path}\``)
    out.push(`- **message_count**: ${messages.length}`)
    out.push('')
    out.push('---')
    out.push('')
  }

  const startOrdinal = options.startOrdinal ?? Number.NEGATIVE_INFINITY
  const endOrdinal = options.endOrdinal ?? Number.POSITIVE_INFINITY

  let first = true
  for (const message of messages) {
    if (message.ordinal < startOrdinal || message.ordinal > endOrdinal) continue
    if (!first) out.push('')
    first = false

    out.push(`## #${message.ordinal} — ${message.role}`)
    const metaBits: string[] = []
    if (message.timestamp) metaBits.push(`\`${message.timestamp}\``)
    if (message.turn_id) metaBits.push(`turn \`${message.turn_id}\``)
    if (metaBits.length > 0) {
      out.push('')
      out.push(metaBits.join(' · '))
    }

    for (const block of message.blocks) {
      out.push('')
      const body = block.body
      if (body.kind === 'inline') {
        if (body.text.length === 0) {
          out.push(`_(empty \`${block.block_type}\` block \`${block.block_id}\`)_`)
        } else if (block.block_type === 'text' && !needsFence(body.text)) {
          // Single-line plain-text content is more readable as a paragraph.
          out.push(body.text)
        } else {
          // CQ-106: escalate the fence past any backtick run inside the body
          // so transcript content containing ``` does not break out of the
          // block. The minimum fence is three backticks per CommonMark; we
          // pick `max(3, longestBacktickRun(body) + 1)`.
          const fence = pickFence(body.text)
          out.push(`**\`${block.block_id}\`** · \`${block.block_type}\``)
          out.push('')
          out.push(fence)
          out.push(body.text)
          out.push(fence)
        }
      } else {
        const mime = body.mime_type ? `, \`${body.mime_type}\`` : ''
        out.push(
          `> **\`${block.block_id}\`** · \`${block.block_type}\` → \`${body.object_id}\` ` +
            `(${body.byte_length} bytes${mime})`,
        )
        if (body.preview.length > 0) {
          // CQ-106: same fence-escalation logic for the preview text.
          const fence = pickFence(body.preview)
          out.push('>')
          out.push(`> ${fence}`)
          for (const line of body.preview.split('\n')) {
            out.push(`> ${line}`)
          }
          out.push(`> ${fence}`)
        }
      }
    }
  }

  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

function needsFence(text: string): boolean {
  return text.includes('\n') || text.includes('`')
}

/**
 * Pick a CommonMark fence whose backtick count exceeds the longest
 * contiguous backtick run in `text`. Returns at minimum the standard
 * three-backtick fence.
 */
function pickFence(text: string): string {
  let longestRun = 0
  let current = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x60 /* ` */) {
      current += 1
      if (current > longestRun) longestRun = current
    } else {
      current = 0
    }
  }
  const fenceLength = Math.max(3, longestRun + 1)
  return '`'.repeat(fenceLength)
}
