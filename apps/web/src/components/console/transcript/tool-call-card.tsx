import { useState } from 'react'

import { CasText } from './cas-text.js'
import type { TranscriptToolCall } from './types.js'

export type ToolCallCardProps = {
  toolCall: TranscriptToolCall
}

function statusTone(toolCall: TranscriptToolCall): 'success' | 'error' | 'neutral' {
  if (toolCall.result?.isError) return 'error'
  const status = (toolCall.status ?? toolCall.result?.status ?? '').toLowerCase()
  if (['error', 'failed', 'failure'].includes(status)) return 'error'
  if (['ok', 'success', 'completed'].includes(status)) return 'success'
  return 'neutral'
}

/**
 * Collapsible tool invocation card. Renders a one-line summary (name + status
 * badge); expanding shows the input section (command/path/args) and the
 * result preview, with an opt-in "Show full" that swaps the preview for a
 * CAS-backed lazy fetch.
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [showFullOutput, setShowFullOutput] = useState(false)
  const tone = statusTone(toolCall)
  const outputObjectId =
    toolCall.result?.outputObjectId ?? toolCall.result?.stdoutObjectId ?? toolCall.result?.stderrObjectId ?? null
  const hasArgsInline = toolCall.argsInline != null && toolCall.argsInline.length > 0
  const hasResultPreview = toolCall.result?.preview != null && toolCall.result.preview.length > 0
  return (
    <div className="transcript-tool-card" data-status={tone}>
      <button
        type="button"
        className="transcript-tool-card-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="transcript-tool-card-toggle" aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="transcript-tool-card-name">{toolCall.toolName}</span>
        <span className={`transcript-tool-card-status transcript-tool-card-status--${tone}`}>
          {toolCall.result?.status ?? toolCall.status ?? '—'}
        </span>
      </button>
      {expanded ? (
        <div className="transcript-tool-card-body">
          <section className="transcript-tool-input">
            <h4>Input</h4>
            {toolCall.command ? <pre>{toolCall.command}</pre> : null}
            {toolCall.path ? <p className="transcript-tool-path">path: {toolCall.path}</p> : null}
            {hasArgsInline ? <pre>{toolCall.argsInline}</pre> : null}
            {!toolCall.command && !hasArgsInline && toolCall.argsObjectId ? (
              <CasText objectId={toolCall.argsObjectId} className="transcript-tool-output" />
            ) : null}
            {!toolCall.command && !hasArgsInline && !toolCall.argsObjectId ? (
              <p className="transcript-tool-empty">No input recorded.</p>
            ) : null}
          </section>
          <section className="transcript-tool-output-section">
            <h4>Result</h4>
            {toolCall.result ? (
              <>
                {hasResultPreview && !showFullOutput ? (
                  <pre className="transcript-tool-output">{toolCall.result.preview}</pre>
                ) : null}
                {showFullOutput && outputObjectId ? <CasText objectId={outputObjectId} /> : null}
                {!showFullOutput && outputObjectId ? (
                  <button type="button" className="transcript-show-full-btn" onClick={() => setShowFullOutput(true)}>
                    Show full output
                  </button>
                ) : null}
                {!hasResultPreview && !outputObjectId ? (
                  <p className="transcript-tool-empty">No result recorded.</p>
                ) : null}
              </>
            ) : (
              <p className="transcript-tool-empty">No result yet.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
