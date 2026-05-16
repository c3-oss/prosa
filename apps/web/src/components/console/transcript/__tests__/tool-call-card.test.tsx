import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '~/test/render.js'

import { ToolCallCard } from '../tool-call-card.js'
import type { TranscriptToolCall } from '../types.js'

const successCall: TranscriptToolCall = {
  toolCallId: 'tc-1',
  toolName: 'bash.run',
  canonicalToolType: null,
  argsInline: '{"cmd":"ls"}',
  argsObjectId: null,
  command: null,
  path: null,
  status: 'success',
  timestampStart: '2026-04-01T10:00:00Z',
  result: {
    toolResultId: 'tr-1',
    status: 'success',
    isError: false,
    exitCode: 0,
    durationMs: 1200,
    preview: 'ok',
    stdoutObjectId: null,
    stderrObjectId: null,
    outputObjectId: 'obj-output-1',
  },
}

describe('ToolCallCard', () => {
  it('renders collapsed by default and shows the tool name + status', () => {
    const { getByRole, queryByText } = renderWithProviders(<ToolCallCard toolCall={successCall} />)
    const button = getByRole('button', { expanded: false })
    expect(button.textContent).toContain('bash.run')
    expect(button.textContent).toContain('success')
    // Body sections are absent while collapsed.
    expect(queryByText('Input')).toBeNull()
    expect(queryByText('Result')).toBeNull()
  })

  it('expands to show input and result preview, then can request full output', () => {
    const { getByRole, getByText, queryByText } = renderWithProviders(<ToolCallCard toolCall={successCall} />)
    fireEvent.click(getByRole('button'))
    expect(getByText('Input')).toBeInTheDocument()
    expect(getByText('Result')).toBeInTheDocument()
    expect(getByText('ok')).toBeInTheDocument()
    // CAS-backed full output is available — the button must be present.
    const showFull = getByRole('button', { name: /Show full output/ })
    expect(showFull).toBeInTheDocument()
    fireEvent.click(showFull)
    // After clicking the preview is replaced; CasText starts in loading state.
    expect(queryByText('Show full output')).toBeNull()
  })
})
