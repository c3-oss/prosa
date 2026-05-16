import { CasText } from './cas-text.js'
import { MarkdownRenderer } from './markdown-renderer.js'
import { ThinkingBlock } from './thinking-block.js'
import { ToolCallCard } from './tool-call-card.js'
import type { TranscriptTurn } from './types.js'

export type AssistantMessageCardProps = {
  turn: TranscriptTurn
}

export function AssistantMessageCard({ turn }: AssistantMessageCardProps) {
  return (
    <article className="transcript-turn transcript-turn--assistant" aria-label={`Assistant message ${turn.ordinal}`}>
      <header className="transcript-turn-header">
        <span className="transcript-turn-role">assistant</span>
        {turn.model ? <span className="transcript-turn-model">{turn.model}</span> : null}
        {turn.timestamp ? <time>{turn.timestamp}</time> : null}
      </header>
      <div className="transcript-turn-body">
        {turn.blocks.map((block) => {
          if (block.hidden || block.blockType === 'thinking') {
            return <ThinkingBlock key={block.blockId} block={block} />
          }
          if (block.textInline) {
            return <MarkdownRenderer key={block.blockId} content={block.textInline} />
          }
          if (block.textObjectId) {
            return <CasText key={block.blockId} objectId={block.textObjectId} />
          }
          return null
        })}
        {turn.toolCalls.length > 0 ? (
          <div className="transcript-tool-calls" aria-label="Tool calls">
            {turn.toolCalls.map((toolCall) => (
              <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}
