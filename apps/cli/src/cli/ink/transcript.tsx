import type { SessionTranscript, TranscriptBlock, TranscriptToolCall, TranscriptTurn } from '@c3-oss/prosa-core'
import { Badge, StatusMessage } from '@inkjs/ui'
import { Box, Static, Text, render } from 'ink'
import type React from 'react'

/** Options controlling the Ink-based transcript rendering. */
export interface RenderTranscriptInkOptions {
  /** When true, thinking blocks are rendered in full (dim/italic). Default false. */
  showThinking?: boolean
  /** Max preview/output lines to keep per tool result; over-long output is truncated. */
  maxOutputLines?: number
}

const DEFAULT_MAX_OUTPUT_LINES = 40

type RoleColor = NonNullable<React.ComponentProps<typeof Badge>['color']>

const ROLE_COLOR: Record<TranscriptTurn['role'], RoleColor> = {
  user: 'magenta',
  assistant: 'cyan',
  tool: 'yellow',
  system_prompt: 'gray',
  developer: 'gray',
  operational: 'gray',
}

/**
 * Render a `SessionTranscript` as Ink output to `process.stdout`. Uses
 * `<Static>` so frames are committed sequentially and never repainted; this
 * preserves the streaming feel and stays sane even when stdout is captured.
 *
 * Callers should branch to `formatTranscriptText` (plain string) when stdout
 * is not a TTY or the user disabled color — Ink is the colored interactive
 * path only.
 */
export async function renderTranscriptInk(
  transcript: SessionTranscript,
  options: RenderTranscriptInkOptions = {},
): Promise<void> {
  const showThinking = options.showThinking ?? false
  const maxOutputLines = options.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES

  // Pre-compute the sequence of sections for <Static>. <Static> wants a stable
  // array; iterating turns + tail "unattached" group keeps that contract.
  type Section =
    | { kind: 'header'; transcript: SessionTranscript }
    | { kind: 'turn'; turn: TranscriptTurn; index: number }
    | { kind: 'unattached'; calls: TranscriptToolCall[] }

  const sections: Section[] = [{ kind: 'header', transcript }]
  transcript.turns.forEach((turn, index) => sections.push({ kind: 'turn', turn, index }))
  if (transcript.unattachedToolCalls.length > 0) {
    sections.push({ kind: 'unattached', calls: transcript.unattachedToolCalls })
  }

  const app = render(
    <Static items={sections.map((section, idx) => ({ section, key: `s-${idx}-${section.kind}` }))}>
      {({ section, key }) => (
        <Box key={key} flexDirection="column" marginBottom={section.kind === 'header' ? 0 : 1}>
          {section.kind === 'header' && <TranscriptHeader transcript={section.transcript} />}
          {section.kind === 'turn' && (
            <TurnView turn={section.turn} showThinking={showThinking} maxOutputLines={maxOutputLines} />
          )}
          {section.kind === 'unattached' && (
            <UnattachedToolCalls calls={section.calls} maxOutputLines={maxOutputLines} />
          )}
        </Box>
      )}
    </Static>,
    { stdout: process.stdout, exitOnCtrlC: false },
  )

  await app.waitUntilExit().catch(() => undefined)
}

function TranscriptHeader({ transcript }: { transcript: SessionTranscript }): React.JSX.Element {
  const s = transcript.session
  const title = s.title?.trim() || `${s.source_tool} session ${s.source_session_id}`
  return (
    <Box flexDirection="column">
      <Text bold>{`# ${title}`}</Text>
      <Text>{`source:     ${s.source_tool}`}</Text>
      <Text>{`session_id: ${s.session_id}`}</Text>
      <Text>{`source_id:  ${s.source_session_id}`}</Text>
      {s.start_ts ? <Text>{`start:      ${s.start_ts}`}</Text> : null}
      {s.end_ts ? <Text>{`end:        ${s.end_ts}`}</Text> : null}
      {s.model_first || s.model_last ? (
        <Text>{`models:     ${s.model_first ?? '?'} → ${s.model_last ?? s.model_first ?? '?'}`}</Text>
      ) : null}
      <Text>{`confidence: ${s.timeline_confidence}`}</Text>
    </Box>
  )
}

function TurnView({
  turn,
  showThinking,
  maxOutputLines,
}: {
  turn: TranscriptTurn
  showThinking: boolean
  maxOutputLines: number
}): React.JSX.Element {
  const color = ROLE_COLOR[turn.role] ?? 'gray'
  const meta: string[] = []
  if (turn.model) meta.push(turn.model)
  if (turn.timestamp) meta.push(turn.timestamp)
  return (
    <Box flexDirection="column">
      <Box>
        <Badge color={color}>{turn.role}</Badge>
        {meta.length > 0 ? <Text dimColor>{` · ${meta.join(' · ')}`}</Text> : null}
      </Box>
      {turn.blocks.map((block, i) => (
        <BlockView key={`b-${i}-${block.blockType}`} block={block} showThinking={showThinking} />
      ))}
      {turn.toolCalls.map((call, i) => (
        <ToolCallView key={`tc-${i}-${call.toolName}`} call={call} maxOutputLines={maxOutputLines} indent={2} />
      ))}
    </Box>
  )
}

function BlockView({ block, showThinking }: { block: TranscriptBlock; showThinking: boolean }): React.JSX.Element {
  const isThinking = block.hidden || block.blockType === 'thinking'
  if (isThinking && !showThinking) {
    const charCount = block.text ? block.text.length : 0
    return (
      <Text dimColor italic>
        {`  ▶ thinking (≈${charCount} chars)`}
      </Text>
    )
  }
  if (block.text == null) {
    if (block.textObjectId) {
      return <Text dimColor>{`  ▶ ${block.blockType} (oversize; objectId=${block.textObjectId})`}</Text>
    }
    return <Text />
  }
  if (isThinking) {
    return (
      <Box flexDirection="column">
        {block.text.split('\n').map((line, i) => (
          // Content lines are render-stable (Static commits once); pairing
          // index with `line.length` gives Biome a non-pure-index key.
          <Text key={`th-${i}-${line.length}`} dimColor italic>
            {`  ${line}`}
          </Text>
        ))}
      </Box>
    )
  }

  // Multi-line text blocks that look like code (fenced or indented) get a
  // light border; everything else just renders as wrapped Text lines. We
  // detect the simplest case (a triple-backtick fence) and strip the fence.
  const fenced = stripCodeFence(block.text)
  if (fenced) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginLeft={2} flexDirection="column">
        <Text>{fenced}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {block.text.split('\n').map((line, i) => (
        <Text key={`ln-${i}-${line.length}`}>{`  ${line}`}</Text>
      ))}
    </Box>
  )
}

function stripCodeFence(text: string): string | null {
  const match = text.match(/^```[\w-]*\n([\s\S]*?)\n```\s*$/)
  return match ? (match[1] ?? null) : null
}

function ToolCallView({
  call,
  maxOutputLines,
  indent,
}: {
  call: TranscriptToolCall
  maxOutputLines: number
  indent: number
}): React.JSX.Element {
  const pad = ' '.repeat(indent)
  const status = call.status
  const isError = Boolean(call.result?.isError)
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="yellow">{`${pad}▶ tool: ${call.toolName}`}</Text>
        {status ? (
          <>
            <Text> </Text>
            <Badge color={isError ? 'red' : 'green'}>{status}</Badge>
          </>
        ) : null}
        {isError && !status ? (
          <>
            <Text> </Text>
            <Badge color="red">error</Badge>
          </>
        ) : null}
      </Box>
      {call.command ? <Text>{`${pad}  $ ${call.command}`}</Text> : null}
      {call.path ? <Text>{`${pad}  path: ${call.path}`}</Text> : null}
      <ToolCallArgs call={call} maxOutputLines={maxOutputLines} pad={`${pad}  `} />
      <ToolCallResult call={call} maxOutputLines={maxOutputLines} pad={`${pad}  `} />
    </Box>
  )
}

function ToolCallArgs({
  call,
  maxOutputLines,
  pad,
}: {
  call: TranscriptToolCall
  maxOutputLines: number
  pad: string
}): React.JSX.Element | null {
  if (call.argsInline) {
    const argsLines = call.argsInline.split('\n')
    const shown = argsLines.slice(0, maxOutputLines)
    const overflow = argsLines.length - maxOutputLines
    return (
      <Box flexDirection="column">
        {shown.map((line, i) => (
          <Text key={`a-${i}-${line.length}`}>{`${pad}${line}`}</Text>
        ))}
        {overflow > 0 ? (
          <StatusMessage variant="info">
            {`${overflow} more lines; use --max-output-lines or open via objectId=${call.argsObjectId ?? '?'}`}
          </StatusMessage>
        ) : null}
      </Box>
    )
  }
  if (call.argsObjectId) {
    return <Text dimColor>{`${pad}args: objectId=${call.argsObjectId} (oversize)`}</Text>
  }
  return null
}

function ToolCallResult({
  call,
  maxOutputLines,
  pad,
}: {
  call: TranscriptToolCall
  maxOutputLines: number
  pad: string
}): React.JSX.Element | null {
  const result = call.result
  if (!result) return null
  if (result.preview) {
    const previewLines = result.preview.split('\n')
    const shown = previewLines.slice(0, maxOutputLines)
    const overflow = previewLines.length - maxOutputLines
    const objectId = result.outputObjectId ?? result.stdoutObjectId ?? result.stderrObjectId
    return (
      <Box flexDirection="column">
        <Text dimColor>{`${pad}─ result ─`}</Text>
        {shown.map((line, i) => (
          <Text key={`r-${i}-${line.length}`}>{`${pad}${line}`}</Text>
        ))}
        {overflow > 0 ? (
          <StatusMessage variant="info">
            {`${overflow} more lines; use --max-output-lines or open via objectId=${objectId ?? '?'}`}
          </StatusMessage>
        ) : null}
        {result.isError ? <StatusMessage variant="error">tool call returned an error</StatusMessage> : null}
      </Box>
    )
  }
  if (result.outputObjectId || result.stdoutObjectId) {
    return <Text dimColor>{`${pad}result objectId=${result.outputObjectId ?? result.stdoutObjectId}`}</Text>
  }
  if (result.isError) {
    return <StatusMessage variant="error">{`${pad}tool call returned an error`}</StatusMessage>
  }
  return null
}

function UnattachedToolCalls({
  calls,
  maxOutputLines,
}: {
  calls: TranscriptToolCall[]
  maxOutputLines: number
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>── tool calls (unattached) ──</Text>
      {calls.map((call, i) => (
        <ToolCallView key={`utc-${i}-${call.toolName}`} call={call} maxOutputLines={maxOutputLines} indent={0} />
      ))}
    </Box>
  )
}
