import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import type { DatabaseHandle, RawExec } from '../../../db.js'
import type { AuthenticatedUser, ProsaApiContext } from '../../context.js'

export type SyncHandlerContext = {
  req: ProsaApiContext['req']
  res: ProsaApiContext['res']
  rawExec: RawExec
  transaction: DatabaseHandle['transaction']
  objectStore: RemoteObjectStore
  tenantId: string
  user: AuthenticatedUser
}
