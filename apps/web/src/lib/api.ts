import type { AppRouter } from '@c3-oss/prosa-api'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import type { WebRuntimeConfig } from './config.js'

export type ProsaTRPCClient = ReturnType<typeof createTRPCClient<AppRouter>>

export type CreateClientOptions = {
  config: WebRuntimeConfig
  /** Returns the active tenant id, if any, when each request is built. */
  getTenantId?: () => string | null
}

const TENANT_HEADER = 'x-prosa-tenant-id'

/**
 * Build a tRPC client wired for browser cookie sessions. Every request
 * includes credentials so Better Auth session cookies travel; the active
 * tenant is sent as a candidate header which the server independently
 * verifies against the `member` table before exposing tenant data.
 */
export function createApiClient(opts: CreateClientOptions): ProsaTRPCClient {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${opts.config.apiUrl}/trpc`,
        fetch(input, init) {
          return fetch(input, { ...init, credentials: 'include' })
        },
        headers() {
          const tenantId = opts.getTenantId?.() ?? null
          if (!tenantId) return {}
          return { [TENANT_HEADER]: tenantId }
        },
      }),
    ],
  })
}

export type ApiError = {
  code?: string
  message: string
  status?: number
}

export function normalizeError(err: unknown): ApiError {
  if (err && typeof err === 'object' && 'message' in err) {
    const candidate = err as { message?: unknown; data?: { code?: string; httpStatus?: number } }
    const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown error'
    return {
      message,
      code: candidate.data?.code,
      status: candidate.data?.httpStatus,
    }
  }
  return { message: 'Unknown error' }
}
