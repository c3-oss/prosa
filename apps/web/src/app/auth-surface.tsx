import type { ReactNode } from 'react'

import { AuthProvider } from './auth-context.js'

/**
 * Wraps a route subtree (auth or console) in the `AuthProvider`, which
 * hydrates session state via `auth.me`. Public/marketing routes do NOT
 * mount this surface, so they never call `/trpc/auth.me` or `/api/auth/*`
 * on first render. Lane-08 CQ-002 enforces this boundary.
 */
export function AuthSurface({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}
