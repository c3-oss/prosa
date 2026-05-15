/**
 * Centralized React Query keys. Keep keys tenant-scoped where applicable so
 * tenant switching can target invalidation surgically.
 */
export const queryKeys = {
  authMe: () => ['auth', 'me'] as const,
  tenantList: () => ['tenant', 'list'] as const,
  analyticsSummary: (tenantId: string) => ['analytics', 'summary', tenantId] as const,
  sessionsList: (tenantId: string, params: unknown) => ['sessions', 'list', tenantId, params] as const,
  sessionsCount: (tenantId: string, params: unknown) => ['sessions', 'count', tenantId, params] as const,
  sessionDetail: (tenantId: string, sessionId: string) => ['sessions', 'detail', tenantId, sessionId] as const,
  searchQuery: (tenantId: string, params: unknown) => ['search', 'query', tenantId, params] as const,
  toolCallsList: (tenantId: string, params: unknown) => ['toolCalls', 'list', tenantId, params] as const,
  analyticsReport: (tenantId: string, params: unknown) => ['analytics', 'report', tenantId, params] as const,
  artifactText: (tenantId: string, ref: unknown) => ['artifacts', 'getText', tenantId, ref] as const,
} as const
