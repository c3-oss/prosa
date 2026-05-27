import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('defaults to memory object store with sensible host/port when in test mode', () => {
    const config = loadConfig({ PROSA_RUNTIME_MODE: 'test' } as NodeJS.ProcessEnv)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(3000)
    expect(config.objectStore.driver).toBe('memory')
    expect(config.authCookieCacheMaxAgeSeconds).toBe(0)
  })

  it('requires PROSA_OBJECT_STORE_BUCKET when driver=s3', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'test',
        PROSA_OBJECT_STORE_DRIVER: 's3',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError)
  })

  it('requires PROSA_OBJECT_STORE_ROOT when driver=fs', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'test',
        PROSA_OBJECT_STORE_DRIVER: 'fs',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError)
  })

  it('refuses production startup without PROSA_AUTH_SECRET', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'production',
        PROSA_DATABASE_URL: 'postgres://x',
        PROSA_OBJECT_STORE_DRIVER: 's3',
        PROSA_OBJECT_STORE_BUCKET: 'b',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PROSA_AUTH_SECRET/)
  })

  it('refuses production startup without PROSA_DATABASE_URL', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'production',
        PROSA_AUTH_SECRET: 'a-real-production-secret-1234',
        PROSA_OBJECT_STORE_DRIVER: 's3',
        PROSA_OBJECT_STORE_BUCKET: 'b',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PROSA_DATABASE_URL/)
  })

  it('refuses memory object store in production', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'production',
        PROSA_AUTH_SECRET: 'a-real-production-secret-1234',
        PROSA_DATABASE_URL: 'postgres://x',
        PROSA_OBJECT_STORE_DRIVER: 'memory',
      } as NodeJS.ProcessEnv),
    ).toThrow(/memory/)
  })

  it('CQ-146: refuses production startup without PROSA_CURSOR_HMAC_SECRET', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'production',
        PROSA_AUTH_SECRET: 'a-real-production-secret-1234',
        PROSA_DATABASE_URL: 'postgres://x',
        PROSA_OBJECT_STORE_DRIVER: 's3',
        PROSA_OBJECT_STORE_BUCKET: 'b',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PROSA_CURSOR_HMAC_SECRET/)
  })

  it('CQ-146: rejects PROSA_CURSOR_HMAC_SECRET shorter than 32 chars even in production', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'production',
        PROSA_AUTH_SECRET: 'a-real-production-secret-1234',
        PROSA_DATABASE_URL: 'postgres://x',
        PROSA_OBJECT_STORE_DRIVER: 's3',
        PROSA_OBJECT_STORE_BUCKET: 'b',
        PROSA_CURSOR_HMAC_SECRET: 'too-short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid configuration/)
  })

  it('CQ-146: production accepts a sufficient PROSA_CURSOR_HMAC_SECRET', () => {
    const config = loadConfig({
      PROSA_RUNTIME_MODE: 'production',
      PROSA_AUTH_SECRET: 'a-real-production-secret-1234',
      PROSA_DATABASE_URL: 'postgres://x',
      PROSA_OBJECT_STORE_DRIVER: 's3',
      PROSA_OBJECT_STORE_BUCKET: 'b',
      PROSA_CURSOR_HMAC_SECRET: 'a-real-cursor-hmac-secret-of-32+-bytes',
    } as NodeJS.ProcessEnv)
    expect(config.cursorHmacSecret).toBe('a-real-cursor-hmac-secret-of-32+-bytes')
  })

  it('CQ-146: test/development boots may omit the cursor secret', () => {
    const test = loadConfig({ PROSA_RUNTIME_MODE: 'test' } as NodeJS.ProcessEnv)
    expect(test.cursorHmacSecret).toBeNull()
  })

  it('accepts a complete s3 config', () => {
    const config = loadConfig({
      PROSA_RUNTIME_MODE: 'test',
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

  it('allows an explicit short Better Auth cookie cache window', () => {
    const config = loadConfig({
      PROSA_RUNTIME_MODE: 'test',
      PROSA_AUTH_COOKIE_CACHE_MAX_AGE_SECONDS: '120',
    } as NodeJS.ProcessEnv)
    expect(config.authCookieCacheMaxAgeSeconds).toBe(120)
  })

  it('rejects excessive Better Auth cookie cache windows', () => {
    expect(() =>
      loadConfig({
        PROSA_RUNTIME_MODE: 'test',
        PROSA_AUTH_COOKIE_CACHE_MAX_AGE_SECONDS: '3600',
      } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError)
  })
})
