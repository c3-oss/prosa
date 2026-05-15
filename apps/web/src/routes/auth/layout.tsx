import { Outlet } from '@tanstack/react-router'

export function AuthLayout() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr',
        minHeight: '100vh',
        background: 'var(--color-bg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-12) var(--space-6)',
        }}
      >
        <div style={{ width: 'min(380px, 100%)' }}>
          <Outlet />
        </div>
      </div>
    </div>
  )
}
