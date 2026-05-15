export function DocsPage() {
  return (
    <section className="marketing-section" aria-labelledby="docs-heading">
      <h2 id="docs-heading">Documentation</h2>
      <p style={{ color: 'var(--color-text-muted)' }}>
        See the canonical references under `docs/` in the repository. Architecture, source formats, and CLI command
        surfaces are kept there as the source of truth.
      </p>
    </section>
  )
}
