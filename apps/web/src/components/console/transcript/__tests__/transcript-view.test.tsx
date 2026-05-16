import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '~/test/render.js'

import { TranscriptView } from '../transcript-view.js'
import type { TranscriptTurn } from '../types.js'

const turns: TranscriptTurn[] = [
  {
    messageId: 'm1',
    ordinal: 1,
    role: 'user',
    model: null,
    timestamp: '2026-04-01T10:00:00Z',
    blocks: [
      {
        blockId: 'b-u-1',
        blockType: 'text',
        textInline: 'Hello assistant',
        textObjectId: null,
        hidden: false,
        isError: false,
        mimeType: 'text/plain',
      },
    ],
    toolCalls: [],
  },
  {
    messageId: 'm2',
    ordinal: 2,
    role: 'assistant',
    model: 'gpt-5',
    timestamp: '2026-04-01T10:00:30Z',
    blocks: [
      {
        blockId: 'b-a-1',
        blockType: 'text',
        textInline: 'Sure, here is **markdown**.',
        textObjectId: null,
        hidden: false,
        isError: false,
        mimeType: 'text/markdown',
      },
    ],
    toolCalls: [],
  },
]

describe('TranscriptView', () => {
  it('renders one user turn and one assistant turn with the right roles', () => {
    const { getAllByLabelText } = renderWithProviders(<TranscriptView turns={turns} />)
    const userTurn = getAllByLabelText(/User message/)
    const assistantTurn = getAllByLabelText(/Assistant message/)
    expect(userTurn).toHaveLength(1)
    expect(assistantTurn).toHaveLength(1)
  })

  it('renders inline user text as plain text (no markdown roles)', () => {
    const { getByText } = renderWithProviders(<TranscriptView turns={turns} />)
    expect(getByText('Hello assistant')).toBeInTheDocument()
  })

  it('renders assistant markdown with the markdown wrapper', () => {
    const { container } = renderWithProviders(<TranscriptView turns={turns} />)
    expect(container.querySelector('.transcript-markdown')).not.toBeNull()
  })
})
