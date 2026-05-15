import { Link } from '@tanstack/react-router'

import { Button } from '~/components/primitives/button.js'

export function LandingPage() {
  return (
    <>
      <section className="marketing-hero" aria-labelledby="hero-heading">
        <div>
          <h1 id="hero-heading">A searchable console for agent session history.</h1>
          <p>
            prosa compiles your local Codex, Claude Code, Cursor, Gemini CLI, and Hermes sessions into one canonical
            store, then promotes them to a multi-tenant console for search, audit, and analytics.
          </p>
          <div className="marketing-hero-cta">
            <Link to="/signup">
              <Button variant="primary" size="md">
                Create account
              </Button>
            </Link>
            <Link to="/product">
              <Button variant="secondary" size="md">
                See the product
              </Button>
            </Link>
          </div>
        </div>
        <div className="marketing-cli-card" aria-hidden="false">
          <div className="marketing-cli-card-comment"># Quickstart</div>
          <div className="marketing-cli-card-line">$ pnpm dlx @c3-oss/prosa@latest sessions</div>
          <div className="marketing-cli-card-line">$ prosa auth login</div>
          <div className="marketing-cli-card-line">$ prosa sync push</div>
          <div className="marketing-cli-card-comment"># Then open the console</div>
          <div className="marketing-cli-card-line">→ console.prosa.dev</div>
        </div>
      </section>
      <section className="marketing-section" aria-labelledby="features-heading">
        <h2 id="features-heading">Observability for agent work</h2>
        <div className="marketing-feature-grid">
          <article className="marketing-feature-card">
            <h3>Search</h3>
            <p>Full-text search across promoted messages, tool calls, and indexed evidence — tenant-scoped.</p>
          </article>
          <article className="marketing-feature-card">
            <h3>Timeline</h3>
            <p>Inspect every session as a structured timeline of messages, tool calls, results, and artifacts.</p>
          </article>
          <article className="marketing-feature-card">
            <h3>Tool calls</h3>
            <p>Audit every command, file edit, and external tool invocation an agent made on your behalf.</p>
          </article>
          <article className="marketing-feature-card">
            <h3>Analytics</h3>
            <p>Sessions, tools, errors, models, and projects reports — same semantics as the CLI.</p>
          </article>
          <article className="marketing-feature-card">
            <h3>Team console</h3>
            <p>Invite teammates, scope by tenant, and share promoted history without copying bundle files.</p>
          </article>
        </div>
      </section>
    </>
  )
}
