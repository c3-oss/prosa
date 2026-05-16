import type { TranscriptBlock } from './types.js'

export type ThinkingBlockProps = {
  block: TranscriptBlock
}

/**
 * Hidden-by-default reasoning block. Uses native `<details>` so the
 * collapse/expand behavior survives without controlled state, keyboard
 * accessibility is free, and the surrounding turn card stays simple.
 */
export function ThinkingBlock({ block }: ThinkingBlockProps) {
  const text = block.textInline ?? ''
  const charCount = text.length
  return (
    <details className="transcript-thinking">
      <summary className="transcript-thinking-summary">thinking · {charCount.toLocaleString()} chars</summary>
      <pre className="transcript-thinking-body">{text || '(empty)'}</pre>
    </details>
  )
}
