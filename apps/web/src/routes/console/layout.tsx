import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { AuthSurface } from '~/app/auth-surface.js'
import { useAppContext } from '~/app/providers.js'
import { TenantSwitcher } from '~/components/console/tenant-switcher.js'
import { Button } from '~/components/primitives/button.js'

const navItems = [
  { to: '/console', label: 'Dashboard' },
  { to: '/console/sessions', label: 'Sessions' },
  { to: '/console/search', label: 'Search' },
  { to: '/console/tool-calls', label: 'Tool calls' },
  { to: '/console/analytics', label: 'Analytics' },
] as const

export function ConsoleLayout() {
  return (
    <AuthSurface>
      <ConsoleLayoutBody />
    </AuthSurface>
  )
}

function ConsoleLayoutBody() {
  const location = useLocation()
  const navigate = useNavigate()
  const { auth, setTenantId } = useAppContext()
  const { status, me } = useAuth()
  const queryClient = useQueryClient()

  // Fail-closed on unauthenticated console access.
  useEffect(() => {
    if (status === 'unauthenticated') {
      navigate({ to: '/login' })
    }
  }, [status, navigate])

  // Mirror active tenant into the app context so tRPC requests include
  // `x-prosa-tenant-id` for every console call.
  useEffect(() => {
    setTenantId(me?.tenantId ?? null)
  }, [me?.tenantId, setTenantId])

  const logout = useMutation({
    mutationFn: () => auth.signOut(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      queryClient.clear()
      navigate({ to: '/login' })
    },
  })

  if (status === 'pending') {
    return (
      <div className="console-shell">
        <div className="console-content">
          <p style={{ color: 'var(--color-text-muted)' }}>Loading session…</p>
        </div>
      </div>
    )
  }

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
          <TenantSwitcher />
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
          <div
            className="console-sidebar-section"
            style={{
              marginTop: 'auto',
              borderTop: '1px solid var(--color-border-subtle)',
              paddingTop: 'var(--space-3)',
            }}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>{me?.user.email ?? ''}</span>
            <Button variant="ghost" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              {logout.isPending ? 'Signing out…' : 'Sign out'}
            </Button>
          </div>
        </aside>
        <section className="console-main" aria-label="Console content">
          <Outlet />
        </section>
      </div>
    </div>
  )
}
