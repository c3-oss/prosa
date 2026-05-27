// Lane 7 — v2 authority cache barrel.
export {
  AUTHORITY_TTL_MS,
  clearCachedAuthority,
  defaultV2AuthorityDir,
  getCachedAuthority,
  isFresh,
  writeCachedAuthority,
} from './cache.js'
export {
  AuthorityChangedError,
  type AuthorityRefreshWire,
  AuthorityResolveError,
  type RefreshAuthorityNowOptions,
  type ResolveAuthorityOptions,
  refreshAuthorityNow,
  resolveAuthority,
} from './resolve.js'
export type { CachedAuthorityV2, CachedAuthorityV2AuditStatus } from './types.js'
