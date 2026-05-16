import { CasText } from './cas-text.js'
import { MarkdownRenderer } from './markdown-renderer.js'
import { ThinkingBlock } from './thinking-block.js'
import type { TranscriptTurn } from './types.js'

/**
 * Heuristic: a block looks like markdown when it contains a fence, a heading,
 * a bullet, or a link. We err toward markdown for assistants and toward plain
 * text for users so casual user prompts stay readable.
 */
function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)\s{0,3}(#|[-*+]\s|\d+\.\s|>\s|```)/.test(text) || /\[[^\]]+]\([^)]+\)/.test(text)
}

export type UserMessageCardProps = {
  turn: TranscriptTurn
}

export function UserMessageCard({ turn }: UserMessageCardProps) {
  return (
    <article className="transcript-turn transcript-turn--user" aria-label={`User message ${turn.ordinal}`}>
      <header className="transcript-turn-header">
        <span className="transcript-turn-role">user</span>
        {turn.timestamp ? <time>{turn.timestamp}</time> : null}
      </header>
      <div className="transcript-turn-body">
        {turn.blocks.map((block) => {
          if (block.hidden) return <ThinkingBlock key={block.blockId} block={block} />
          if (block.textInline) {
            if (looksLikeMarkdown(block.textInline)) {
              return <MarkdownRenderer key={block.blockId} content={block.textInline} />
            }
            return (
              <p key={block.blockId} className="transcript-plain-text">
                {block.textInline}
              </p>
            )
          }
          if (block.textObjectId) {
            return <CasText key={block.blockId} objectId={block.textObjectId} />
          }
          return null
        })}
      </div>
    </article>
  )
}
