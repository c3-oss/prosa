import { Link, Outlet, useLocation } from '@tanstack/react-router'

const navItems = [
  { to: '/console', label: 'Dashboard' },
  { to: '/console/sessions', label: 'Sessions' },
  { to: '/console/search', label: 'Search' },
  { to: '/console/tool-calls', label: 'Tool calls' },
  { to: '/console/analytics', label: 'Analytics' },
] as const

export function ConsoleLayout() {
  const location = useLocation()
  return (
    <div className="console-shell">
      <header className="console-command-bar">
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--font-size-md)' }}>prosa console</strong>
        <span style={{ color: 'var(--color-text-faint)', fontSize: 'var(--font-size-sm)' }}>
          Tenant-scoped, remote-authoritative reads.
        </span>
      </header>
      <div className="console-frame">
        <aside className="console-sidebar" aria-label="Console navigation">
          <div className="console-sidebar-section">
            <span>Tenant</span>
            <span style={{ color: 'var(--color-text)', fontFamily: 'var(--font-mono)' }}>—</span>
          </div>
          <nav className="console-nav" aria-label="Primary">
            {navItems.map((item) => (
              <Link key={item.to} to={item.to} data-active={location.pathname === item.to ? 'true' : undefined}>
                {item.label}
              </Link>
            ))}
            <Link to="/console/settings/$section" params={{ section: 'team' }}>
              Settings
            </Link>
          </nav>
        </aside>
        <section className="console-main" aria-label="Console content">
          <Outlet />
        </section>
      </div>
    </div>
  )
}
