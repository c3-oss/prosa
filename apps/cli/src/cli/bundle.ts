import path from 'node:path'
import { type Bundle, BundleNotInitializedError, closeBundle, defaultBundlePath, openBundle } from '@c3-oss/prosa-core'
import { CliUserError } from './errors.js'

/** Open a bundle for one CLI action and guarantee the SQLite handle is closed afterward. */
export async function withBundle<T>(storePath: string, fn: (bundle: Bundle) => Promise<T> | T): Promise<T> {
  const bundle = await openCliBundle(storePath)
  try {
    return await fn(bundle)
  } finally {
    closeBundle(bundle)
  }
}

/** Open a bundle for CLI commands, translating missing-store failures into user guidance. */
export async function openCliBundle(storePath: string): Promise<Bundle> {
  try {
    return await openBundle(path.resolve(storePath))
  } catch (error) {
    throw asCliBundleOpenError(error)
  }
}

/** Convert known bundle-open failures into terse CLI errors. */
export function asCliBundleOpenError(error: unknown): unknown {
  if (error instanceof BundleNotInitializedError) {
    return new CliUserError(formatMissingBundleMessage(error.bundlePath))
  }
  return error
}

function formatMissingBundleMessage(bundlePath: string): string {
  const resolved = path.resolve(bundlePath)
  const defaultPath = defaultBundlePath()
  if (resolved === defaultPath && !process.env.PROSA_STORE) {
    return `No default prosa store found at ${resolved}.\nRun \`prosa v1 init\` to create it.`
  }

  return `No prosa store found at ${resolved}.\nRun \`prosa v1 init --store ${resolved}\` to create it.`
}
