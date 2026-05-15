import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('defaults to memory object store with sensible host/port', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.objectStore.driver).toBe('memory')
  })

  it('requires PROSA_OBJECT_STORE_BUCKET when driver=s3', () => {
    expect(() => loadConfig({ PROSA_OBJECT_STORE_DRIVER: 's3' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
  })

  it('requires PROSA_OBJECT_STORE_ROOT when driver=fs', () => {
    expect(() => loadConfig({ PROSA_OBJECT_STORE_DRIVER: 'fs' } as NodeJS.ProcessEnv)).toThrow(ConfigError)
  })

  it('accepts a complete s3 config', () => {
    const config = loadConfig({
      PROSA_OBJECT_STORE_DRIVER: 's3',
      PROSA_OBJECT_STORE_BUCKET: 'my-bucket',
      PROSA_OBJECT_STORE_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv)
    expect(config.objectStore).toMatchObject({
      driver: 's3',
      bucket: 'my-bucket',
      region: 'us-east-1',
    })
  })
})
