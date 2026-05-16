import { AssistantMessageCard } from './assistant-message-card.js'
import { ToolCallCard } from './tool-call-card.js'
import type { TranscriptToolCall, TranscriptTurn } from './types.js'
import { UserMessageCard } from './user-message-card.js'

export type TranscriptViewProps = {
  turns: TranscriptTurn[]
  unattachedToolCalls?: TranscriptToolCall[]
}

/**
 * Renders an ordered transcript of message turns plus any tool calls that
 * could not be attached to a message. The view stays lightweight — heavy
 * lifting (markdown, CAS lazy fetch) happens inside the per-turn cards.
 */
export function TranscriptView({ turns, unattachedToolCalls = [] }: TranscriptViewProps) {
  return (
    <section className="transcript-view" aria-label="Conversation transcript">
      {turns.map((turn) => {
        if (turn.role === 'assistant') {
          return <AssistantMessageCard key={turn.messageId} turn={turn} />
        }
        if (turn.role === 'user') {
          return <UserMessageCard key={turn.messageId} turn={turn} />
        }
        // System / developer / tool / operational turns reuse the user card
        // styling — it stays neutral enough to host any role without claiming
        // visual emphasis the way assistant turns do.
        return <UserMessageCard key={turn.messageId} turn={turn} />
      })}
      {unattachedToolCalls.length > 0 ? (
        <div className="transcript-unattached" aria-label="Unattached tool calls">
          <h3 className="transcript-unattached-heading">Tool calls without a message</h3>
          {unattachedToolCalls.map((toolCall) => (
            <ToolCallCard key={toolCall.toolCallId} toolCall={toolCall} />
          ))}
        </div>
      ) : null}
    </section>
  )
}
