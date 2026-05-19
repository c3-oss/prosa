// Hermes Provider (v2) — minimal first iteration.
//
// Scope (intentionally minimal):
//   - Discover `*.jsonl` and `session_*.json` files under the sessions
//     directory.
//   - Cheap-identify by the first `session_id`-bearing field; fall back
//     to filename-derived id if absent.
//   - Emit one `SessionV2` + one `SourceFileV2` per file, plus one
//     `RawRecordV2` per JSONL line (or per messages[] entry for JSON
//     snapshots, or one whole-doc raw_record when the snapshot has no
//     messages array).
//
// Out of scope: SQLite `state.db` cross-reference, `sessions.json`
// index merging (hermes_sqlite_plus_jsonl merge strategy),
// per-message turn/message/tool-call projection.

import { readFile } from 'node:fs/promises'
import { basename, normalize } from 'node:path'

import {
  canonicalTimestamp,
  deriveRawRecordId,
  deriveSourceFileId,
  isValidCanonicalTimestamp,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import {
  type CheapIdentification,
  type DiscoveredSourceFile,
  type LogicalImportUnit,
  type Provider,
  type ProviderProjectInput,
  type ProviderProjectResult,
  emptyDraft,
} from '../types.js'
import { type HermesFileKind, discoverHermesFiles } from './discover.js'

const SOURCE_TOOL = 'hermes' as const

interface DiscoveredHermesFile extends DiscoveredSourceFile {
  hermes_kind: HermesFileKind
}

interface HermesEnvelope {
  session_id?: string
  sessionId?: string
  id?: string
  timestamp?: string
  type?: string
  role?: string
  model?: string
  content?: unknown
}

interface HermesJsonSnapshot {
  session_id?: string
  sessionId?: string
  id?: string
  start_time?: string
  end_time?: string
  model?: string
  summary?: string
  messages?: HermesEnvelope[]
}

function pickSessionId(env: HermesEnvelope | HermesJsonSnapshot | null): string | null {
  if (!env) return null
  if (typeof env.session_id === 'string' && env.session_id.length > 0) return env.session_id
  if (typeof env.sessionId === 'string' && env.sessionId.length > 0) return env.sessionId
  if (typeof env.id === 'string' && env.id.length > 0) return env.id
  return null
}

export class HermesProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredHermesFile[] = []
    for await (const hint of discoverHermesFiles(root)) {
      const bytes = await readFile(hint.filePath)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      out.push({
        source_file_id: deriveSourceFileId({
          source_tool: SOURCE_TOOL,
          path: normalize(hint.filePath),
          content_hash: contentHash,
        }),
        path: hint.filePath,
        source_tool: SOURCE_TOOL,
        file_kind: hint.kind,
        bytes,
        hermes_kind: hint.kind,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    const bytes = file.bytes ?? (await readFile(file.path))
    const enriched = file as DiscoveredHermesFile
    let sessionId: string | null = null
    if (enriched.hermes_kind === 'session_jsonl') {
      const text = new TextDecoder().decode(bytes)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const env = JSON.parse(trimmed) as HermesEnvelope
          const id = pickSessionId(env)
          if (id !== null) {
            sessionId = id
            break
          }
        } catch {
          // skip malformed line
        }
      }
    } else {
      try {
        const snap = JSON.parse(new TextDecoder().decode(bytes)) as HermesJsonSnapshot
        sessionId = pickSessionId(snap)
      } catch {
        sessionId = null
      }
    }
    if (sessionId === null) {
      // Fall back to filename without extension as the logical id.
      const name = basename(file.path).replace(/\.jsonl?$|\.json$/, '')
      sessionId = name
    }
    return {
      logicalKey: new TextEncoder().encode(`hermes:${sessionId}`),
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('hermes parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const enriched = file as DiscoveredHermesFile
    const rawRecordIds: string[] = []
    let sessionId: string | null = null
    let sessionStartTs: string | null = null
    let sessionEndTs: string | null = null
    let modelFirst: string | null = null
    let modelLast: string | null = null
    let summary: string | null = null

    if (enriched.hermes_kind === 'session_jsonl') {
      const text = new TextDecoder().decode(bytes)
      const lines = text.split('\n')
      let ordinal = 0
      let logicalOffset = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        if (!line) {
          logicalOffset += 1
          continue
        }
        const byteLength = new TextEncoder().encode(line).length
        let env: HermesEnvelope | null = null
        try {
          env = JSON.parse(line) as HermesEnvelope
        } catch {
          env = null
        }
        if (env) {
          if (sessionId === null) sessionId = pickSessionId(env)
          if (
            sessionStartTs === null &&
            typeof env.timestamp === 'string' &&
            isValidCanonicalTimestamp(env.timestamp)
          ) {
            sessionStartTs = canonicalTimestamp(env.timestamp)
          }
          if (typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)) {
            sessionEndTs = canonicalTimestamp(env.timestamp)
          }
          if (typeof env.model === 'string') {
            if (modelFirst === null) modelFirst = env.model
            modelLast = env.model
          }
        }
        const rawRecordId = deriveRawRecordId({
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          ordinal,
          record_kind: 'session_jsonl_line',
        })
        rawRecordIds.push(rawRecordId)
        draft.raw_records.push({
          raw_record_id: rawRecordId,
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          record_kind: 'session_jsonl_line',
          ordinal,
          logical_offset: logicalOffset,
          logical_length: byteLength,
          line_no: i + 1,
          json_pointer: null,
          parser_status: env ? 'parsed' : 'unparseable',
          confidence: env ? 'high' : 'low',
          content_hash: contentHash,
          object_id: contentHash,
          decoded_object_id: null,
          created_at: input.createdAt,
        })
        ordinal += 1
        logicalOffset += byteLength + 1
      }
    } else {
      // session_json — one raw_record per messages[] entry, or one
      // whole-doc record when the snapshot has no messages array.
      let snap: HermesJsonSnapshot | null = null
      try {
        snap = JSON.parse(new TextDecoder().decode(bytes)) as HermesJsonSnapshot
      } catch {
        snap = null
      }
      if (snap) {
        sessionId = pickSessionId(snap)
        if (typeof snap.start_time === 'string' && isValidCanonicalTimestamp(snap.start_time)) {
          sessionStartTs = canonicalTimestamp(snap.start_time)
        }
        if (typeof snap.end_time === 'string' && isValidCanonicalTimestamp(snap.end_time)) {
          sessionEndTs = canonicalTimestamp(snap.end_time)
        }
        if (typeof snap.model === 'string') {
          modelFirst = snap.model
          modelLast = snap.model
        }
        if (typeof snap.summary === 'string') summary = snap.summary
      }
      const messages = snap?.messages ?? []
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]
          const rawRecordId = deriveRawRecordId({
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            ordinal: i,
            record_kind: 'session_jsonl_line',
          })
          rawRecordIds.push(rawRecordId)
          draft.raw_records.push({
            raw_record_id: rawRecordId,
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            record_kind: 'session_jsonl_line',
            ordinal: i,
            logical_offset: 0,
            logical_length: 0,
            line_no: null,
            json_pointer: `/messages/${i}`,
            parser_status: m ? 'parsed' : 'unparseable',
            confidence: m ? 'high' : 'low',
            content_hash: contentHash,
            object_id: contentHash,
            decoded_object_id: null,
            created_at: input.createdAt,
          })
        }
      } else {
        const rawRecordId = deriveRawRecordId({
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          ordinal: 0,
          record_kind: 'session_jsonl_line',
        })
        rawRecordIds.push(rawRecordId)
        draft.raw_records.push({
          raw_record_id: rawRecordId,
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          record_kind: 'session_jsonl_line',
          ordinal: 0,
          logical_offset: 0,
          logical_length: bytes.length,
          line_no: null,
          json_pointer: null,
          parser_status: snap ? 'parsed' : 'unparseable',
          confidence: snap ? 'high' : 'low',
          content_hash: contentHash,
          object_id: contentHash,
          decoded_object_id: null,
          created_at: input.createdAt,
        })
      }
    }

    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: enriched.hermes_kind,
      size_bytes: bytes.length,
      mtime_ns: null,
      content_hash: contentHash,
      object_id: contentHash,
      pack_digest: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      stored_offset: 0,
      stored_length: bytes.length,
      compression: 'zstd',
      last_seen_epoch: 1,
    })

    const sessionLogicalId = sessionId ?? basename(file.path).replace(/\.jsonl?$|\.json$/, '')
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(`hermes:${sessionLogicalId}`))).slice(0, 32)}`
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary,
      start_ts: sessionStartTs ?? input.createdAt,
      end_ts: sessionEndTs,
      cwd_initial: null,
      git_branch_initial: null,
      model_first: modelFirst,
      model_last: modelLast,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: rawRecordIds[0] ?? null,
    })

    const unit: LogicalImportUnit = {
      unit_id: input.identification.unit_id,
      source_tool: SOURCE_TOOL,
      logical_kind: 'session',
      source_file_ids: [file.source_file_id],
      raw_record_ids: rawRecordIds,
      raw_source_payloads: new Map([[file.source_file_id, bytes]]),
      projection: draft,
      raw_source_leaves: [
        {
          source_file_id: file.source_file_id,
          content_hash: contentHash,
          uncompressed_size: bytes.length,
          compression: 'zstd',
          stored_hash: contentHash,
        },
      ],
      // The minimal slice treats each file as its own LogicalImportUnit;
      // the full `hermes_sqlite_plus_jsonl` strategy lands in a follow-up.
      merge: { merge_strategy: 'single_source' },
    }
    return { unit, summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length } }
  }
}

export { discoverHermesFiles } from './discover.js'
export type { HermesFileHint, HermesFileKind } from './discover.js'
