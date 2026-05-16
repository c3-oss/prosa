import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'

import { useAppContext } from './providers.js'

export type AuthMeUser = { id: string; email: string; name: string }
export type AuthMeTenant = { id: string; name: string; slug: string | null; role: string }
export type AuthMeSnapshot = {
  user: AuthMeUser
  tenantId: string | null
  memberRole: string | null
  tenants: AuthMeTenant[]
}

type AuthContextValue = {
  status: 'pending' | 'unauthenticated' | 'authenticated' | 'error'
  me: AuthMeSnapshot | null
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { api } = useAppContext()
  const queryClient = useQueryClient()
  const autoActivatedTenantRef = useRef<string | null>(null)
  const query = useQuery({
    queryKey: ['auth', 'me'] as const,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      try {
        const result = (await api.auth.me.query()) as AuthMeSnapshot
        return result
      } catch (err) {
        if (isUnauthorized(err)) return null
        throw err
      }
    },
  })

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
  }, [queryClient])

  useEffect(() => {
    const snapshot = query.data
    if (!snapshot || snapshot.tenantId || snapshot.tenants.length !== 1) return

    const tenantId = snapshot.tenants[0]?.id
    if (!tenantId || autoActivatedTenantRef.current === tenantId) return

    autoActivatedTenantRef.current = tenantId
    let cancelled = false

    api.tenant.setActive
      .mutate({ tenantId })
      .then(async () => {
        if (!cancelled) await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] })
      })
      .catch(() => {
        if (autoActivatedTenantRef.current === tenantId) autoActivatedTenantRef.current = null
      })

    return () => {
      cancelled = true
    }
  }, [api, query.data, queryClient])

  const value = useMemo<AuthContextValue>(() => {
    const me = normalizeAuthSnapshot(query.data ?? null)
    const error = query.error instanceof Error ? query.error : null
    const status: AuthContextValue['status'] = query.isLoading
      ? 'pending'
      : error
        ? 'error'
        : me
          ? 'authenticated'
          : 'unauthenticated'
    return { status, me, isLoading: query.isLoading, error, refresh }
  }, [query.data, query.error, query.isLoading, refresh])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

function normalizeAuthSnapshot(snapshot: AuthMeSnapshot | null): AuthMeSnapshot | null {
  if (!snapshot) return null

  if (!snapshot.tenantId && snapshot.tenants.length === 1) {
    const tenant = snapshot.tenants[0]
    if (!tenant) return snapshot
    return {
      ...snapshot,
      tenantId: tenant.id,
      memberRole: snapshot.memberRole ?? tenant.role,
    }
  }

  if (snapshot.tenantId && !snapshot.memberRole) {
    const tenant = snapshot.tenants.find((candidate) => candidate.id === snapshot.tenantId)
    if (tenant) return { ...snapshot, memberRole: tenant.role }
  }

  return snapshot
}

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { data?: { httpStatus?: number; code?: string } }
  if (candidate.data?.httpStatus === 401) return true
  if (candidate.data?.code === 'UNAUTHORIZED') return true
  return false
}
