import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import {
  BarChart3,
  Database,
  Gauge,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  TerminalSquare,
} from 'lucide-react'
import { type ComponentType, useEffect, useMemo, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { AuthSurface } from '~/app/auth-surface.js'
import { useAppContext } from '~/app/providers.js'
import { TenantSwitcher } from '~/components/console/tenant-switcher.js'
import { Button } from '~/components/primitives/button.js'

const SIDEBAR_STORAGE_KEY = 'prosa:console-sidebar:collapsed'

type NavItem = {
  to: '/console' | '/console/sessions' | '/console/search' | '/console/tool-calls' | '/console/analytics'
  label: string
  icon: ComponentType<{ size?: number; strokeWidth?: number }>
  match: (pathname: string) => boolean
}

const navItems: NavItem[] = [
  { to: '/console', label: 'Dashboard', icon: Gauge, match: (path) => path === '/console' },
  { to: '/console/sessions', label: 'Sessions', icon: Database, match: (path) => path.startsWith('/console/sessions') },
  { to: '/console/search', label: 'Search', icon: Search, match: (path) => path.startsWith('/console/search') },
  {
    to: '/console/tool-calls',
    label: 'Tool calls',
    icon: TerminalSquare,
    match: (path) => path.startsWith('/console/tool-calls'),
  },
  {
    to: '/console/analytics',
    label: 'Analytics',
    icon: BarChart3,
    match: (path) => path.startsWith('/console/analytics'),
  },
]

function readInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

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
  const { auth, tenantId, setTenantId } = useAppContext()
  const { status, me } = useAuth()
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState(readInitialCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const activeTenantId = me?.tenantId ?? null
  const hasTenantMismatch = status === 'authenticated' && activeTenantId !== null && tenantId !== activeTenantId
  const currentLabel = useMemo(() => {
    if (location.pathname.startsWith('/console/settings')) return 'Settings'
    return navItems.find((item) => item.match(location.pathname))?.label ?? 'Console'
  }, [location.pathname])

  useEffect(() => {
    if (status === 'unauthenticated') navigate({ to: '/login' })
  }, [status, navigate])

  useEffect(() => {
    setTenantId(activeTenantId)
  }, [activeTenantId, setTenantId])

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed))
    } catch {
      // Ignore localStorage errors; collapse state is cosmetic.
    }
  }, [collapsed])

  // biome-ignore lint/correctness/useExhaustiveDependencies: close the mobile drawer when the route pathname changes.
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

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
          <p className="console-muted">Loading session…</p>
        </div>
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return (
      <div className="console-shell">
        <div className="console-content">
          <p className="console-muted">Redirecting to sign in…</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="console-shell"
      data-sidebar-collapsed={collapsed ? 'true' : undefined}
      data-mobile-open={mobileOpen ? 'true' : undefined}
    >
      {mobileOpen ? (
        <button
          type="button"
          className="console-mobile-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside className="console-sidebar" aria-label="Console navigation">
        <SidebarContent
          collapsed={collapsed}
          pathname={location.pathname}
          email={me?.user.email ?? ''}
          logoutPending={logout.isPending}
          onLogout={() => logout.mutate()}
        />
      </aside>
      <div className="console-workspace">
        <header className="console-command-bar">
          <div className="console-command-left">
            <button
              type="button"
              className="console-icon-button console-mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={18} />
            </button>
            <button
              type="button"
              className="console-icon-button console-desktop-only"
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <div className="console-breadcrumb" aria-label="Breadcrumb">
              <span className="console-breadcrumb-root">prosa</span>
              <span className="console-faint">/</span>
              <span className="console-breadcrumb-current">{currentLabel}</span>
            </div>
          </div>
          <div className="console-command-right">
            <span className="console-connected-badge">
              <Database size={13} /> remote reads
            </span>
          </div>
        </header>
        <section className="console-main" aria-label="Console content">
          {hasTenantMismatch ? (
            <ConsoleStateMessage message="Preparing tenant-scoped console state…" />
          ) : !activeTenantId ? (
            <ConsoleStateMessage
              message={
                me?.tenants.length === 0
                  ? 'No tenant memberships were found for this account.'
                  : 'Pick a tenant in the sidebar to continue.'
              }
            />
          ) : (
            <Outlet />
          )}
        </section>
      </div>
    </div>
  )
}

function SidebarContent({
  collapsed,
  pathname,
  email,
  logoutPending,
  onLogout,
}: {
  collapsed: boolean
  pathname: string
  email: string
  logoutPending: boolean
  onLogout: () => void
}) {
  return (
    <div className="console-sidebar-inner">
      <Link to="/console" className="console-brand" title="prosa console">
        <span className="console-brand-mark" aria-hidden="true">
          <Database size={16} strokeWidth={2.4} />
        </span>
        <span className="console-brand-text">prosa</span>
      </Link>
      <div className="console-sidebar-expanded-only">
        <TenantSwitcher />
      </div>
      <nav className="console-nav" aria-label="Primary">
        <span className="console-sidebar-label console-sidebar-expanded-only">Explore</span>
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              data-active={item.match(pathname) ? 'true' : undefined}
            >
              <span className="console-nav-icon" aria-hidden="true">
                <Icon size={17} />
              </span>
              <span className="console-nav-label">{item.label}</span>
            </Link>
          )
        })}
        <Link
          to="/console/settings/$section"
          params={{ section: 'team' }}
          title={collapsed ? 'Settings' : undefined}
          data-active={pathname.startsWith('/console/settings') ? 'true' : undefined}
        >
          <span className="console-nav-icon" aria-hidden="true">
            <Settings size={17} />
          </span>
          <span className="console-nav-label">Settings</span>
        </Link>
      </nav>
      <div className="console-sidebar-footer">
        <div className="console-user-chip console-sidebar-expanded-only">
          <span className="console-user-email">{email}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          disabled={logoutPending}
          className="console-sidebar-action"
          title={collapsed ? 'Sign out' : undefined}
        >
          <LogOut size={16} />
          <span className="console-nav-label">{logoutPending ? 'Signing out…' : 'Sign out'}</span>
        </Button>
      </div>
    </div>
  )
}

function ConsoleStateMessage({ message }: { message: string }) {
  return (
    <div className="console-content">
      <p className="console-muted" style={{ margin: 0 }}>
        {message}
      </p>
    </div>
  )
}
