import type { SessionTranscript } from '@c3-oss/prosa-core'
import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { type FlatLine, flattenTranscript } from './use-flat-lines.js'

interface Props {
  transcript: SessionTranscript
  height: number
  scroll: number
  selectedLine: number
  showThinking: boolean
  expandedTurns: Set<number>
  maxOutputLines: number
  /** Pre-flattened lines; supplied when the host already memoizes. */
  lines?: FlatLine[]
}

/** Render a transcript window with one Ink `<Text>` per flat line. */
export function TranscriptView(props: Props): React.JSX.Element {
  const flat = useMemo(() => {
    if (props.lines) return props.lines
    return flattenTranscript(props.transcript, {
      showThinking: props.showThinking,
      expandedTurns: props.expandedTurns,
      maxOutputLines: props.maxOutputLines,
    })
  }, [props.lines, props.transcript, props.showThinking, props.expandedTurns, props.maxOutputLines])

  // Reserve one row for the help bar; the host adds it below us.
  const usable = Math.max(1, props.height - 1)
  const slice = flat.slice(props.scroll, props.scroll + usable)

  return (
    <Box flexDirection="column" height={props.height}>
      {slice.map((line, idx) => {
        const absoluteIndex = props.scroll + idx
        const isSelected = absoluteIndex === props.selectedLine
        // The flat array is stable for a given (transcript, flags) tuple;
        // (kind, absoluteIndex) is unique within a render so it's safe.
        const key = `${line.kind}-${absoluteIndex}`
        return (
          <Box key={key}>
            <FlatLineText line={line} selected={isSelected} />
          </Box>
        )
      })}
    </Box>
  )
}

function FlatLineText({ line, selected }: { line: FlatLine; selected: boolean }): React.JSX.Element {
  const props = styleFor(line)
  return (
    <Text color={props.color} bold={props.bold} italic={props.italic} dimColor={props.dim} inverse={selected}>
      {line.text.length === 0 ? ' ' : line.text}
    </Text>
  )
}

interface LineStyle {
  color?: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
}

function styleFor(line: FlatLine): LineStyle {
  switch (line.kind) {
    case 'session-header':
      return { color: 'cyan', bold: true }
    case 'turn-header':
      return turnHeaderStyle(line.role)
    case 'block-text':
      // User/assistant text stays default; tool-role blocks get a dim hint.
      if (line.isError) return { color: 'red' }
      if (line.role === 'tool' || line.role === 'system_prompt' || line.role === 'developer') {
        return { dim: true }
      }
      return {}
    case 'thinking-collapsed':
    case 'thinking-expanded':
      return { dim: true, italic: true }
    case 'tool-call-header':
      return { color: line.isError ? 'red' : 'yellow' }
    case 'tool-call-input':
      return { dim: true }
    case 'tool-call-output':
      return line.isError ? { color: 'red' } : {}
    case 'tool-call-truncation':
      return { color: 'cyan', italic: true }
    case 'unattached-header':
      return { color: 'yellow', bold: true }
    case 'separator':
      return {}
    default:
      return {}
  }
}

function turnHeaderStyle(role: FlatLine['role']): LineStyle {
  switch (role) {
    case 'user':
      return { color: 'magenta', bold: true }
    case 'assistant':
      return { color: 'cyan', bold: true }
    case 'tool':
      return { color: 'yellow', bold: true }
    case 'system_prompt':
    case 'developer':
    case 'operational':
      return { color: 'gray', bold: true }
    default:
      return { bold: true }
  }
}
