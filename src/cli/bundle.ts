import path from 'node:path'
import { type Bundle, closeBundle, openBundle } from '../core/bundle.js'

/** Open a bundle for one CLI action and guarantee the SQLite handle is closed afterward. */
export async function withBundle<T>(storePath: string, fn: (bundle: Bundle) => Promise<T> | T): Promise<T> {
  const bundle = await openBundle(path.resolve(storePath))
  try {
    return await fn(bundle)
  } finally {
    closeBundle(bundle)
  }
}
