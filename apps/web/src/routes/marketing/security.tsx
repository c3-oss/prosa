export function SecurityPage() {
  return (
    <section className="marketing-section" aria-labelledby="security-heading">
      <h2 id="security-heading">Security model</h2>
      <ul style={{ color: 'var(--color-text-muted)', lineHeight: 'var(--line-height-loose)' }}>
        <li>Browser sessions are cookie-based; we never mirror tokens or cookies into localStorage.</li>
        <li>Every read endpoint validates tenant membership server-side against the verified `member` table.</li>
        <li>Promoted data is gated on verified projection manifests; unverified rows are not exposed.</li>
        <li>Artifact and object reads prove tenant ownership and never expose raw storage keys.</li>
        <li>The CLI bearer/device auth path is independent from the browser cookie session.</li>
      </ul>
    </section>
  )
}
