import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

export type MarkdownRendererProps = {
  /** Markdown source. Empty string renders nothing. */
  content: string
}

/**
 * Thin wrapper around `react-markdown` configured with GFM (tables,
 * strikethrough) and syntax-highlighted code fences. The component returns
 * plain markup; the surrounding `.transcript-markdown` class supplies the
 * theme-aware styling so callers do not need to ship their own tokens.
 */
export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  if (!content) return null
  return (
    <div className="transcript-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
