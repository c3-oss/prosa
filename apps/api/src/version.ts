import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function readJsonVersion(path: string): string | null {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

export function readPackageVersion(): string {
  return (
    readJsonVersion(resolve(here, '../../package.json')) ?? readJsonVersion(resolve(here, '../package.json')) ?? '0.0.0'
  )
}
