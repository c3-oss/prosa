import path from 'node:path'
import { type Bundle, closeBundle, openBundle } from '../core/bundle.js'

export async function withBundle<T>(storePath: string, fn: (bundle: Bundle) => Promise<T> | T): Promise<T> {
  const bundle = await openBundle(path.resolve(storePath))
  try {
    return await fn(bundle)
  } finally {
    closeBundle(bundle)
  }
}
