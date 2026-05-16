import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '~/test/render.js'

import { MarkdownRenderer } from '../markdown-renderer.js'

describe('MarkdownRenderer', () => {
  it('renders an empty string as nothing', () => {
    const { container } = renderWithProviders(<MarkdownRenderer content="" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders fenced code blocks with the `hljs` class via rehype-highlight', () => {
    const md = ['```ts', 'const x: number = 1', '```'].join('\n')
    const { container } = renderWithProviders(<MarkdownRenderer content={md} />)
    const codeEl = container.querySelector('pre code')
    expect(codeEl).not.toBeNull()
    // rehype-highlight tags the code element with `hljs` plus language class.
    expect(codeEl?.className).toMatch(/hljs/)
    expect(codeEl?.className).toMatch(/language-ts/)
  })

  it('renders GFM tables (remark-gfm)', () => {
    const md = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    const { container } = renderWithProviders(<MarkdownRenderer content={md} />)
    expect(container.querySelector('table')).not.toBeNull()
  })
})
