// Codex Provider (v2).
//
// First iteration covers the load-bearing path: discover JSONL files,
// cheap-identify by the first `session_meta` envelope's id, and
// project a minimal `LogicalImportUnit` containing one `SessionV2`,
// one `RawRecordV2` per JSONL line, and one `SourceFileV2`. Full
// turn/message/tool-call/event projection is left to follow-up
// iterations (the v1 importer is 1,696 lines for a reason). The
// orchestrator's CQ-047 backfill stamps the source_file's pack
// metadata at seal time.

import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

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
import { discoverCodexSessionFiles } from './discover.js'
import type { CodexEnvelope, CodexSessionMetaPayload } from './types.js'

const SOURCE_TOOL = 'codex' as const
const FILE_KIND = 'session_jsonl'

export class CodexProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredSourceFile[] = []
    for await (const path of discoverCodexSessionFiles(root)) {
      const bytes = await readFile(path)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      const sourceFileId = deriveSourceFileId({
        source_tool: SOURCE_TOOL,
        path: normalize(path),
        content_hash: contentHash,
      })
      out.push({
        source_file_id: sourceFileId,
        path,
        source_tool: SOURCE_TOOL,
        file_kind: FILE_KIND,
        bytes,
      })
    }
    return out
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // Walk just enough of the file to find the first session_meta
    // envelope. The id field there is the canonical logical session
    // identifier (cross-file dedupe key when the same session is
    // discovered through more than one path, e.g. tarball + flat dir).
    const bytes = file.bytes ?? (await readFile(file.path))
    const text = new TextDecoder().decode(bytes)
    let logicalKey: Uint8Array | null = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let env: CodexEnvelope
      try {
        env = JSON.parse(trimmed) as CodexEnvelope
      } catch {
        continue
      }
      if (env.type === 'session_meta') {
        const id = (env.payload as CodexSessionMetaPayload | undefined)?.id
        if (typeof id === 'string' && id.length > 0) {
          logicalKey = new TextEncoder().encode(`codex:${id}`)
          break
        }
      }
    }
    if (!logicalKey) {
      // Fall back to the source_file_id when no session_meta exists
      // (rare; some legacy rollouts open with a turn_context). The
      // logical key still dedupes correctly because two files with
      // identical bytes derive the same source_file_id.
      logicalKey = new TextEncoder().encode(`codex:src:${file.source_file_id}`)
    }
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) {
      throw new Error('codex parseAndProject: no input file')
    }
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()

    // Walk every line into one raw_record. Each raw_record's
    // content_hash + object_id points at the source file's bytes
    // (the canonical raw-source identity). decoded_object_id stays
    // null until a follow-up iteration adds per-line CAS decoding.
    const text = new TextDecoder().decode(bytes)
    const lines = text.split('\n')
    let sessionMetaId: string | null = null
    let sessionStartTs: string | null = null
    const rawRecordIds: string[] = []
    let ordinal = 0
    let logicalOffset = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!line) {
        logicalOffset += 1
        continue
      }
      const lineByteLength = new TextEncoder().encode(line).length
      let env: CodexEnvelope | null = null
      try {
        env = JSON.parse(line) as CodexEnvelope
      } catch {
        env = null
      }
      if (env?.type === 'session_meta' && sessionMetaId === null) {
        const meta = (env.payload as CodexSessionMetaPayload | undefined) ?? {}
        if (typeof meta.id === 'string') sessionMetaId = meta.id
        if (typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)) {
          sessionStartTs = canonicalTimestamp(env.timestamp)
        } else if (typeof meta.timestamp === 'string' && isValidCanonicalTimestamp(meta.timestamp)) {
          sessionStartTs = canonicalTimestamp(meta.timestamp)
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
        logical_length: lineByteLength,
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
      logicalOffset += lineByteLength + 1 // +1 for the newline terminator
    }

    // One source_file row. The orchestrator backfills pack metadata
    // (pack_digest, stored_offset, stored_length, compression, plus
    // the canonical size_bytes) at seal time per CQ-047.
    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: FILE_KIND,
      size_bytes: bytes.length,
      mtime_ns: null,
      content_hash: contentHash,
      object_id: contentHash,
      // Provider placeholder; orchestrator overwrites pre-seal.
      pack_digest: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      stored_offset: 0,
      stored_length: bytes.length,
      compression: 'zstd',
      last_seen_epoch: 1,
    })

    // One session row. The session's logical id derives from the
    // session_meta envelope when present; otherwise it falls back to
    // the unit id (so files without session_meta still seal).
    const sessionLogicalId = sessionMetaId ?? input.identification.unit_id
    const sessionId = `ses_${toHex(blake3(new TextEncoder().encode(`codex:${sessionLogicalId}`))).slice(0, 32)}`
    const firstRawRecordId = rawRecordIds[0] ?? null
    draft.sessions.push({
      session_id: sessionId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary: null,
      start_ts: sessionStartTs ?? input.createdAt,
      end_ts: null,
      cwd_initial: null,
      git_branch_initial: null,
      model_first: null,
      model_last: null,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: firstRawRecordId,
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
      merge: { merge_strategy: 'single_source' },
    }
    return {
      unit,
      summary: {
        files: 1,
        sessions: 1,
        rawRecords: rawRecordIds.length,
      },
    }
  }
}

export { discoverCodexSessionFiles } from './discover.js'
export type { CodexEnvelope, CodexSessionMetaPayload } from './types.js'

// Helper for the `join` import — kept for the `path.normalize` semantics
// the orchestrator's per-row path field expects.
export const _normalizePath = (p: string): string => normalize(p)
export const _joinPath = (a: string, b: string): string => join(a, b)
