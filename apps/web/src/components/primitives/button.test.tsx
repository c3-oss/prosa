import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Button } from './button.js'

describe('Button', () => {
  it('renders an accessible button with default primary variant', () => {
    const { getByRole } = render(<Button>Save</Button>)
    const button = getByRole('button', { name: 'Save' })
    expect(button).toBeInTheDocument()
    expect(button.getAttribute('type')).toBe('button')
  })

  it('passes through type attribute', () => {
    const { getByRole } = render(
      <form>
        <Button type="submit">Submit</Button>
      </form>,
    )
    expect(getByRole('button').getAttribute('type')).toBe('submit')
  })
})
