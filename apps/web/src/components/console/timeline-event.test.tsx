import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { type TimelineEvent, TimelineEventCard } from './timeline-event.js'

const baseEvent: TimelineEvent = {
  id: 'ev-1',
  ordinal: 0,
  timestamp: '2026-04-01T10:00:00Z',
  kind: 'message',
  payload: { messageId: 'msg-1', text: 'hello world' },
}

describe('TimelineEventCard', () => {
  it('renders the event kind label and a payload preview', () => {
    const { getByText, getByRole } = render(
      <TimelineEventCard event={baseEvent} selected={false} onSelect={() => undefined} />,
    )
    expect(getByText('#0 · message')).toBeInTheDocument()
    expect(getByRole('button').getAttribute('aria-pressed')).toBe('false')
    expect(getByText(/hello world/)).toBeInTheDocument()
  })

  it('invokes onSelect when clicked and reflects selected state via aria-pressed', () => {
    const onSelect = vi.fn()
    const { getByRole } = render(<TimelineEventCard event={baseEvent} selected={true} onSelect={onSelect} />)
    const button = getByRole('button')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    button.click()
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('falls back to the unknown style for unrecognised event kinds', () => {
    const unknown: TimelineEvent = { ...baseEvent, id: 'ev-unknown', kind: 'mystery' }
    const { getByText } = render(<TimelineEventCard event={unknown} selected={false} onSelect={() => undefined} />)
    expect(getByText('#0 · unknown')).toBeInTheDocument()
  })
})
