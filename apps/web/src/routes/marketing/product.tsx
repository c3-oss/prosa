export function ProductPage() {
  return (
    <section className="marketing-section" aria-labelledby="product-heading">
      <h2 id="product-heading">Product</h2>
      <p style={{ color: 'var(--color-text-muted)' }}>
        prosa is a local-first store for agent session histories that promotes verified content to a shared console for
        search, timeline inspection, tool-call audit, analytics, and team visibility.
      </p>
      <div className="marketing-feature-grid">
        <article className="marketing-feature-card">
          <h3>Local-first compilation</h3>
          <p>
            Every CLI command operates on a canonical local bundle. The CLI is the source of truth for your machine.
          </p>
        </article>
        <article className="marketing-feature-card">
          <h3>Promotion to remote</h3>
          <p>Sync push promotes content to multi-tenant Postgres + S3-compatible object storage; reads are verified.</p>
        </article>
        <article className="marketing-feature-card">
          <h3>Structured timeline</h3>
          <p>Messages, content blocks, tool calls, tool results, and artifacts render as discrete event kinds.</p>
        </article>
      </div>
    </section>
  )
}
