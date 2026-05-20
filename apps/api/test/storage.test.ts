import { createObjectStoreFromConfig } from '@c3-oss/prosa-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProsaApiConfig } from '../src/config.js'
import { createObjectStore } from '../src/storage.js'

vi.mock('@c3-oss/prosa-storage', () => ({
  createObjectStoreFromConfig: vi.fn((driverConfig: unknown) => ({ driverConfig })),
}))

const baseConfig: Omit<ProsaApiConfig, 'objectStore'> = {
  apiUrl: 'http://127.0.0.1:3000',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  runtimeMode: 'test',
  databaseUrl: null,
  authSecret: 'test-secret-1234567890abcdef',
  cursorHmacSecret: null,
  authCookieCacheMaxAgeSeconds: 0,
  webOrigins: [],
}

function configWithObjectStore(objectStore: ProsaApiConfig['objectStore']): ProsaApiConfig {
  return { ...baseConfig, objectStore }
}

describe('createObjectStore', () => {
  const createFromConfig = vi.mocked(createObjectStoreFromConfig)

  beforeEach(() => {
    createFromConfig.mockClear()
  })

  it('creates a memory object store from API config', () => {
    const store = createObjectStore(configWithObjectStore({ driver: 'memory', prefix: 'tenant-prefix/' }))

    expect(createFromConfig).toHaveBeenCalledWith({ driver: 'memory', prefix: 'tenant-prefix/' })
    expect(store).toEqual({ driverConfig: { driver: 'memory', prefix: 'tenant-prefix/' } })
  })

  it('creates a filesystem object store from API config', () => {
    createObjectStore(configWithObjectStore({ driver: 'fs', root: '/tmp/prosa-objects', prefix: 'fs/' }))

    expect(createFromConfig).toHaveBeenCalledWith({
      driver: 'fs',
      root: '/tmp/prosa-objects',
      prefix: 'fs/',
    })
  })

  it('omits absent optional S3 settings', () => {
    createObjectStore(configWithObjectStore({ driver: 's3', bucket: 'prosa-test', prefix: 's3/' }))

    expect(createFromConfig).toHaveBeenCalledWith({
      driver: 's3',
      bucket: 'prosa-test',
      prefix: 's3/',
    })
  })

  it('passes through configured S3 settings', () => {
    createObjectStore(
      configWithObjectStore({
        driver: 's3',
        bucket: 'prosa-test',
        prefix: 's3/',
        endpoint: 'http://127.0.0.1:9000',
        region: 'us-test-1',
        accessKeyId: 'access-key',
        secretAccessKey: 'secret-key',
      }),
    )

    expect(createFromConfig).toHaveBeenCalledWith({
      driver: 's3',
      bucket: 'prosa-test',
      prefix: 's3/',
      endpoint: 'http://127.0.0.1:9000',
      region: 'us-test-1',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
    })
  })
})
