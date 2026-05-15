import { FsObjectStore } from './adapters/fs.js'
import { MemoryObjectStore } from './adapters/memory.js'
import { S3ObjectStore, type S3ObjectStoreOptions } from './adapters/s3.js'
import type { RemoteObjectStore } from './types.js'

export type ObjectStoreDriverConfig =
  | { driver: 'memory'; prefix: string }
  | { driver: 'fs'; root: string; prefix: string }
  | ({ driver: 's3'; prefix: string } & S3ObjectStoreOptions)

export function createObjectStoreFromConfig(config: ObjectStoreDriverConfig): RemoteObjectStore {
  switch (config.driver) {
    case 'memory':
      return new MemoryObjectStore()
    case 'fs':
      return new FsObjectStore(config.root)
    case 's3':
      return new S3ObjectStore(config)
  }
}
