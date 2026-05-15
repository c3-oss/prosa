import {
  type ObjectStoreDriverConfig,
  type RemoteObjectStore,
  createObjectStoreFromConfig,
} from '@c3-oss/prosa-storage'
import type { ProsaApiConfig } from './config.js'

export function createObjectStore(config: ProsaApiConfig): RemoteObjectStore {
  const cfg = configToDriverConfig(config)
  return createObjectStoreFromConfig(cfg)
}

function configToDriverConfig(config: ProsaApiConfig): ObjectStoreDriverConfig {
  const store = config.objectStore
  switch (store.driver) {
    case 'memory':
      return { driver: 'memory', prefix: store.prefix }
    case 'fs':
      return { driver: 'fs', root: store.root, prefix: store.prefix }
    case 's3': {
      const result: ObjectStoreDriverConfig = {
        driver: 's3',
        prefix: store.prefix,
        bucket: store.bucket,
      }
      if (store.endpoint) result.endpoint = store.endpoint
      if (store.region) result.region = store.region
      if (store.accessKeyId) result.accessKeyId = store.accessKeyId
      if (store.secretAccessKey) result.secretAccessKey = store.secretAccessKey
      return result
    }
  }
}
