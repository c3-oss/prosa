import { access, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '../bundle.js'
import { compressBytes } from '../cas/compress.js'
import { blake3Hex, objectIdFromHash, sha256Hex } from '../cas/hash.js'
import { ensureDir } from '../cas/index.js'
import { prepare } from '../db.js'
import { sourceFileId } from '../domain/ids.js'
import type { SourceTool } from '../domain/types.js'

/**
 * Complete `source_files` row used by source discovery and importer idempotency.
 *
 * Paths are absolute source paths. `object_id` points at preserved raw source
 * bytes and may be backfilled for rows created before raw preservation existed.
 */
export interface SourceFileRow {
  /** Stable source file identifier. */
  source_file_id: string
  /** Importer that discovered the file. */
  source_tool: SourceTool
  /** Absolute path to the native source file. */
  path: string
  /** Importer-specific file kind. */
  file_kind: string
  /** File size observed during discovery. */
  size_bytes: number
  /** Filesystem modification time as ISO text, when available. */
  mtime: string | null
  /** SHA-256 content hash used for idempotency. */
  content_hash: string
  /** CAS object ID for preserved raw bytes, if available. */
  object_id: string | null
  /** ISO timestamp when the file was first registered. */
  discovered_at: string
  /** Optional project/workspace hint derived during discovery. */
  workspace_hint: string | null
}

/**
 * Result of source-file registration.
 *
 * `alreadyKnown` means the same path/content tuple was already registered and
 * the caller can usually skip parsing/importing the file.
 */
export interface RegisterResult {
  /** Registered source file row. */
  row: SourceFileRow
  /** True when the caller can usually skip parsing the file. */
  alreadyKnown: boolean
}

/**
 * Idempotent registration of a source file. The natural key is
 * (source_tool, path, size, mtime, content_hash). If a row with the same
 * tuple already exists we return it untouched and the caller can skip
 * re-importing. Otherwise we insert a new row.
 *
 * This is the cheapest form of idempotency: re-running `prosa compile` over
 * the same Codex tree is a no-op (no rehash unless the file changed).
 */
export async function registerSourceFile(
  bundle: Bundle,
  args: {
    sourceTool: SourceTool
    absolutePath: string
    fileKind: string
    workspaceHint?: string | null
  },
): Promise<RegisterResult> {
  const st = await stat(args.absolutePath)
  const size = st.size
  const mtime = st.mtime.toISOString()

  // Hash on demand. We could memoize per (path,size,mtime) but the cheap
  // pre-check below already covers the common case.
  const cheap = prepare<[SourceTool, string, number, string], SourceFileRow>(
    bundle.db,
    `SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime,
            content_hash, object_id, discovered_at, workspace_hint
       FROM source_files
      WHERE source_tool = ? AND path = ? AND size_bytes = ? AND mtime = ?
      LIMIT 1`,
  ).get(args.sourceTool, args.absolutePath, size, mtime)

  if (cheap) {
    return {
      row: await ensureSourceFilePreserved(bundle, cheap, args.absolutePath),
      alreadyKnown: true,
    }
  }

  const buf = await readFile(args.absolutePath)
  const contentHash = sha256Hex(buf)

  // Slow path: same content under same path was perhaps re-saved with new
  // mtime; honor the (tool,path,size,mtime,hash) UNIQUE constraint.
  const exact = prepare<[SourceTool, string, string], SourceFileRow>(
    bundle.db,
    `SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime,
            content_hash, object_id, discovered_at, workspace_hint
       FROM source_files
      WHERE source_tool = ? AND path = ? AND content_hash = ?
      LIMIT 1`,
  ).get(args.sourceTool, args.absolutePath, contentHash)

  if (exact) {
    return {
      row: await ensureSourceFilePreserved(bundle, exact, args.absolutePath, buf),
      alreadyKnown: true,
    }
  }

  const objectId = await preserveRawSourceBytes(bundle, buf)

  const id = sourceFileId(args.sourceTool, args.absolutePath, contentHash)
  const row: SourceFileRow = {
    source_file_id: id,
    source_tool: args.sourceTool,
    path: args.absolutePath,
    file_kind: args.fileKind,
    size_bytes: size,
    mtime,
    content_hash: contentHash,
    object_id: objectId,
    discovered_at: new Date().toISOString(),
    workspace_hint: args.workspaceHint ?? null,
  }

  prepare(
    bundle.db,
    `INSERT INTO source_files (
       source_file_id, source_tool, path, file_kind, size_bytes, mtime,
       content_hash, object_id, discovered_at, workspace_hint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.source_file_id,
    row.source_tool,
    row.path,
    row.file_kind,
    row.size_bytes,
    row.mtime,
    row.content_hash,
    row.object_id,
    row.discovered_at,
    row.workspace_hint,
  )

  return { row, alreadyKnown: false }
}

/**
 * Backfill raw-byte preservation for an existing `source_files` row.
 *
 * Older rows or cheap-path matches may not have `object_id`; this helper stores
 * the current source bytes and updates the row before returning it.
 */
async function ensureSourceFilePreserved(
  bundle: Bundle,
  row: SourceFileRow,
  absolutePath: string,
  bytes?: Buffer,
): Promise<SourceFileRow> {
  if (row.object_id) return row

  const sourceBytes = bytes ?? (await readFile(absolutePath))
  const objectId = await preserveRawSourceBytes(bundle, sourceBytes)

  prepare<[string, string]>(bundle.db, `UPDATE source_files SET object_id = ? WHERE source_file_id = ?`).run(
    objectId,
    row.source_file_id,
  )

  return { ...row, object_id: objectId }
}

/**
 * Preserve raw source bytes outside the main CAS fanout and record them in
 * `objects`.
 *
 * The storage path is `raw/sources/<blake3>.<ext>` so original input files are
 * easy to distinguish from normalized payloads under `objects/blake3`. The DB
 * insert is idempotent, and the file write is skipped if the object already
 * exists on disk.
 */
async function preserveRawSourceBytes(bundle: Bundle, bytes: Uint8Array): Promise<string> {
  const hash = blake3Hex(bytes)
  const objectId = objectIdFromHash(hash)
  const { bytes: stored, compression } = compressBytes(bytes)
  const storagePath = rawSourceStoragePath(hash, compression)
  const absolutePath = path.join(bundle.path, storagePath)

  await ensureDir(path.dirname(absolutePath))
  if (!(await fileExists(absolutePath))) {
    await writeFile(absolutePath, stored)
  }

  const existing = prepare<[string], { object_id: string }>(
    bundle.db,
    `SELECT object_id FROM objects WHERE object_id = ?`,
  ).get(objectId)

  if (!existing) {
    prepare(
      bundle.db,
      `INSERT INTO objects (
         object_id, hash_alg, hash, size_bytes, compressed_size_bytes,
         compression, mime_type, encoding, storage_path, created_at
       ) VALUES (?, 'blake3', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      objectId,
      hash,
      bytes.byteLength,
      compression === 'zstd' ? stored.byteLength : null,
      compression,
      'application/octet-stream',
      null,
      storagePath,
      new Date().toISOString(),
    )
  }

  return objectId
}

/**
 * Relative bundle path for preserved raw source bytes.
 */
function rawSourceStoragePath(hashHex: string, compression: 'zstd' | 'none'): string {
  const ext = compression === 'zstd' ? '.zst' : '.bin'
  return `raw/sources/${hashHex}${ext}`
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
