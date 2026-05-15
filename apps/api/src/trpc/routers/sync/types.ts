import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { DatabaseHandle, RawExec } from '../../../db.js'
import type { AuthenticatedUser } from '../../context.js'

export type SyncHandlerContext = {
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  tenantId: string
  user: AuthenticatedUser
}
