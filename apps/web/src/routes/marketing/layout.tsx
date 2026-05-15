import { Link, Outlet } from '@tanstack/react-router'

import { useAppContext } from '~/app/providers.js'

export function MarketingLayout() {
  const { config } = useAppContext()
  const docsHref = config.marketingDocsUrl ?? '/docs'
  const githubHref = config.githubUrl ?? 'https://github.com/c3-oss/prosa'
  return (
    <div className="marketing-shell">
      <header className="marketing-header">
        <Link to="/" className="marketing-header-brand">
          <span>prosa</span>
          <span aria-hidden="true" style={{ color: 'var(--color-accent)' }}>
            •
          </span>
        </Link>
        <nav className="marketing-header-nav" aria-label="Marketing navigation">
          <Link to="/product">Product</Link>
          <Link to="/security">Security</Link>
          <a href={docsHref} rel="noreferrer">
            Docs
          </a>
          <a href={githubHref} rel="noreferrer">
            GitHub
          </a>
          <Link to="/login">Login</Link>
          <Link to="/signup" style={{ color: 'var(--color-accent)' }}>
            Start
          </Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="marketing-footer">
        <span>prosa • local-first agent history</span>
        <span>MIT</span>
      </footer>
    </div>
  )
}
