import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, createContext, useCallback, useContext, useMemo } from 'react'

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

  const value = useMemo<AuthContextValue>(() => {
    const me = query.data ?? null
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

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { data?: { httpStatus?: number; code?: string } }
  if (candidate.data?.httpStatus === 401) return true
  if (candidate.data?.code === 'UNAUTHORIZED') return true
  return false
}
