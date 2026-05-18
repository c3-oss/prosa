import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAuth } from '~/app/auth-context.js'
import { useAppContext } from '~/app/providers.js'
import { queryKeys } from '~/lib/query-keys.js'

import { DASHBOARD_LAYOUT_KEY, DEFAULT_LAYOUT, type DashboardLayout, parseLayout } from './layout.js'

const SAVE_DEBOUNCE_MS = 500

export function useDashboardLayout(): {
  layout: DashboardLayout
  setLayout: (next: DashboardLayout) => void
  reset: () => void
  isLoaded: boolean
  isSaving: boolean
} {
  const { api } = useAppContext()
  const { me } = useAuth()
  const queryClient = useQueryClient()
  const tenantId = me?.tenantId ?? null
  const userId = me?.user?.id ?? null

  const remote = useQuery({
    enabled: Boolean(tenantId && userId),
    queryKey:
      tenantId && userId ? queryKeys.userPref(tenantId, userId, DASHBOARD_LAYOUT_KEY) : ['userPref', 'disabled'],
    queryFn: async (): Promise<DashboardLayout> => {
      const res = await api.userPrefs.get.query({ key: DASHBOARD_LAYOUT_KEY })
      return parseLayout(res?.value)
    },
  })

  const [layout, setLayoutState] = useState<DashboardLayout>(DEFAULT_LAYOUT)
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!hydratedRef.current && remote.data) {
      setLayoutState(remote.data)
      hydratedRef.current = true
    }
  }, [remote.data])

  const save = useMutation({
    mutationFn: async (next: DashboardLayout) => {
      await api.userPrefs.set.mutate({ key: DASHBOARD_LAYOUT_KEY, value: next })
    },
    onSuccess: (_data, next) => {
      if (tenantId && userId) {
        queryClient.setQueryData(queryKeys.userPref(tenantId, userId, DASHBOARD_LAYOUT_KEY), next)
      }
    },
  })

  // Debounced persistence so that rapid drag/resize updates batch into a
  // single round-trip. The timer is reset on every change.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const setLayout = useCallback(
    (next: DashboardLayout) => {
      setLayoutState(next)
      if (!tenantId || !userId) return
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => save.mutate(next), SAVE_DEBOUNCE_MS)
    },
    [save, tenantId, userId],
  )
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const reset = useCallback(() => setLayout(DEFAULT_LAYOUT), [setLayout])

  return {
    layout,
    setLayout,
    reset,
    isLoaded: remote.isSuccess || !tenantId || !userId,
    isSaving: save.isPending,
  }
}
