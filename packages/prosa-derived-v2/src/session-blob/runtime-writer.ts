// SessionBlobPackV2 runtime writer.
//
// Closes the Lane 3 transcript-rendering chain:
//
//   1. `compile-v2` writes the canonical projection (messages,
//      content_blocks, tool_calls, sessions) as NDJSON under
//      `<bundleRoot>/epochs/<n>/projection/`.
//   2. This module reads those projection segments, groups the
//      messages + blocks + tool_calls per session, drives
//      `projectionToSessionBlobInputs` + `writeSessionBlobPack`,
//      and writes one pack per session under
//      `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`.
//   3. Downstream code (`loadTranscriptFromBundle`,
//      `formatTranscriptTextV2`, `prosa index-v2 transcript`) reads
//      those packs and produces a renderable transcript.
//
// Pure write side — the runtime executor does not mutate the live
// projection segments, never touches CAS, and is idempotent over
// the (bundleRoot, epoch) tuple: running twice produces the same
// pack bytes on disk because the writer is content-deterministic.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'

import { zstdCompress } from '@c3-oss/prosa-bundle-v2'
import type { ContentBlockV2, MessageV2, ToolCallV2 } from '@c3-oss/prosa-types-v2'

import { sessionBlobEpochDir, sessionBlobPackPath } from '../derived-layout.js'

import { projectionToSessionBlobInputs } from './projection-bridge.js'
import { writeSessionBlobPack } from './writer.js'

/** One entity NDJSON file the runtime needs to read. */
const PROJECTION_FILES = {
  message: 'message.prosa-projection.ndjson',
  content_block: 'content_block.prosa-projection.ndjson',
  tool_call: 'tool_call.prosa-projection.ndjson',
} as const

export interface RunSessionBlobBuildInput {
  /** Absolute bundle root. */
  bundleRoot: string
  /** Epoch whose projection rows should be materialised as packs. */
  epoch: number
}

export interface SessionBlobBuildResult {
  /** Canonical session_id the pack covers. */
  session_id: string
  /** Absolute path the runtime wrote to. */
  packPath: string
  /** Byte length of the pack on disk. */
  byteLength: number
  /** Pack digest from the writer. */
  pack_digest: string
  /** Number of messages packed. */
  messageCount: number
}

export interface RunSessionBlobBuildResult {
  bundleRoot: string
  epoch: number
  /** One result row per session pack the runtime wrote. */
  packs: SessionBlobBuildResult[]
  /** Sessions that appeared in the projection but produced zero
   *  pack messages (no associated content blocks). The runtime
   *  skips these so a downstream reader's pack-not-found path
   *  surfaces correctly. */
  skippedSessions: string[]
}

/**
 * Read the projection NDJSON for the requested epoch, group rows
 * per session, and emit one SessionBlobPackV2 per session under
 * `<bundleRoot>/derived/session-blob/epoch-<n>/<session_id>.pack`.
 *
 * The runtime never reads the bundle outside the requested epoch;
 * cross-epoch session aggregation is the caller's concern (the
 * pack reader's `loadLatestTranscriptForSession` resolves the
 * latest pack across all epochs).
 *
 * Returns `packs: []` when the projection has no
 * `message.prosa-projection.ndjson` segment (no messages → nothing
 * to pack). Sessions without any blocks fall into
 * `skippedSessions` so the result reports them rather than
 * silently emitting zero-byte packs.
 */
export async function runSessionBlobBuild(input: RunSessionBlobBuildInput): Promise<RunSessionBlobBuildResult> {
  const messages = await readProjectionRows<MessageV2>(input.bundleRoot, input.epoch, PROJECTION_FILES.message)
  if (messages.length === 0) {
    return { bundleRoot: input.bundleRoot, epoch: input.epoch, packs: [], skippedSessions: [] }
  }
  const blocks = await readProjectionRows<ContentBlockV2>(input.bundleRoot, input.epoch, PROJECTION_FILES.content_block)
  const toolCalls = await readProjectionRows<ToolCallV2>(input.bundleRoot, input.epoch, PROJECTION_FILES.tool_call)

  // Group messages by session_id so the writer sees a coherent
  // per-session slab. Skip messages without a session_id (the v2
  // schema does not allow null `session_id` on `MessageV2`, but
  // defensively skip anyway).
  const messagesBySession = new Map<string, MessageV2[]>()
  for (const message of messages) {
    if (typeof message.session_id !== 'string' || message.session_id.length === 0) continue
    const list = messagesBySession.get(message.session_id) ?? []
    list.push(message)
    messagesBySession.set(message.session_id, list)
  }

  // Ensure the epoch parent directory exists once; per-session
  // `mkdir -p` is redundant after that.
  await mkdir(sessionBlobEpochDir(input.bundleRoot, input.epoch), { recursive: true })

  const packs: SessionBlobBuildResult[] = []
  const skippedSessions: string[] = []
  // Stable order across runs so re-running the worker against the
  // same bundle produces a deterministic result row order.
  const sessionIds = Array.from(messagesBySession.keys()).sort()
  for (const sessionId of sessionIds) {
    const blobInputs = projectionToSessionBlobInputs({
      session_id: sessionId,
      messages: messagesBySession.get(sessionId) as MessageV2[],
      content_blocks: blocks,
      tool_calls: toolCalls,
    })
    if (blobInputs.length === 0) {
      skippedSessions.push(sessionId)
      continue
    }
    const result = writeSessionBlobPack(
      { session_id: sessionId, epoch: input.epoch, messages: blobInputs },
      zstdCompress,
    )
    const packPath = sessionBlobPackPath(input.bundleRoot, sessionId, input.epoch)
    await writeFile(packPath, result.pack)
    const fileStat = await stat(packPath)
    packs.push({
      session_id: sessionId,
      packPath,
      byteLength: fileStat.size,
      pack_digest: result.pack_digest,
      messageCount: blobInputs.length,
    })
  }
  return { bundleRoot: input.bundleRoot, epoch: input.epoch, packs, skippedSessions }
}

/** Read one canonical-projection NDJSON segment. Skips the header
 *  line. Returns `[]` when the file is absent (the projection
 *  writer omits empty-row entity files). */
async function readProjectionRows<T>(bundleRoot: string, epoch: number, fileName: string): Promise<T[]> {
  const path = `${bundleRoot}/epochs/${epoch}/projection/${fileName}`
  let body: string
  try {
    body = await readFile(path, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const lines = body.split('\n').filter((l) => l.length > 0)
  // First line is the canonical-projection header; entity rows
  // follow.
  const rows: T[] = []
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] as string
    rows.push(JSON.parse(raw) as T)
  }
  return rows
}
