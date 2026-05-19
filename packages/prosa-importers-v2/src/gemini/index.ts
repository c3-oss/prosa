// Gemini CLI Provider (v2) — minimal first iteration.
//
// Each session is a single JSON file with a `messages: []` array.
// First-iteration scope: discover, cheap-identify by `sessionId`,
// and emit one `SessionV2` + one `SourceFileV2` + one `RawRecordV2`
// per `messages[]` entry. Multi-snapshot merging across snapshots
// of the same `sessionId` (Gemini writes a fresh file every save)
// is deferred to a follow-up — for now, each snapshot file is its
// own `LogicalImportUnit` and the Reserve flow on a real shard
// would dedupe at the orchestrator level.
//
// Out of scope: per-message TurnV2/MessageV2/ContentBlockV2/
// ToolCallV2/ToolResultV2 projection, GeminiThought hidden-content
// extraction, file-diff artifact synthesis.

import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'

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
import { discoverGeminiChats } from './discover.js'
import type { GeminiSessionFile } from './types.js'

const SOURCE_TOOL = 'gemini' as const
const FILE_KIND = 'session_json'

interface DiscoveredGeminiFile extends DiscoveredSourceFile {
  project_dir: string
  project_root: string | null
}

export class GeminiProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredGeminiFile[] = []
    for await (const hint of discoverGeminiChats(root)) {
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
        file_kind: FILE_KIND,
        bytes,
        project_dir: hint.projectDir,
        project_root: hint.projectRoot,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    const bytes = file.bytes ?? (await readFile(file.path))
    let sessionId: string | null = null
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as GeminiSessionFile
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) {
        sessionId = parsed.sessionId
      }
    } catch {
      // Corrupt file; fall back to source_file_id below.
    }
    const logicalKey =
      sessionId !== null
        ? new TextEncoder().encode(`gemini:${sessionId}`)
        : new TextEncoder().encode(`gemini:src:${file.source_file_id}`)
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('gemini parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    let parsed: GeminiSessionFile | null = null
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as GeminiSessionFile
    } catch {
      parsed = null
    }
    const messages = parsed?.messages ?? []
    const rawRecordIds: string[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
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
        // Gemini messages live inside a single JSON document; the
        // canonical record_kind is the closest existing enum value.
        record_kind: 'session_jsonl_line',
        ordinal: i,
        logical_offset: 0,
        logical_length: 0,
        line_no: null,
        json_pointer: `/messages/${i}`,
        parser_status: msg ? 'parsed' : 'unparseable',
        confidence: msg ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
    }
    // If the file failed to parse, still emit one raw_record covering
    // the whole JSON document so the bytes are preserved.
    if (rawRecordIds.length === 0) {
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
        parser_status: parsed ? 'parsed' : 'unparseable',
        confidence: parsed ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
    }

    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: FILE_KIND,
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

    const enriched = file as DiscoveredGeminiFile
    const sessionLogicalId =
      typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0
        ? parsed.sessionId
        : input.identification.unit_id
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(`gemini:${sessionLogicalId}`))).slice(0, 32)}`
    const startTs =
      typeof parsed?.startTime === 'string' && isValidCanonicalTimestamp(parsed.startTime)
        ? canonicalTimestamp(parsed.startTime)
        : input.createdAt
    const endTs =
      typeof parsed?.lastUpdated === 'string' && isValidCanonicalTimestamp(parsed.lastUpdated)
        ? canonicalTimestamp(parsed.lastUpdated)
        : null
    // The model field appears on individual messages; take the first
    // assistant message's model as model_first/last for a minimal
    // session row.
    let modelFirst: string | null = null
    let modelLast: string | null = null
    for (const m of messages) {
      if (typeof m?.model === 'string' && m.model.length > 0) {
        if (modelFirst === null) modelFirst = m.model
        modelLast = m.model
      }
    }
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
      summary: typeof parsed?.summary === 'string' ? parsed.summary : null,
      start_ts: startTs,
      end_ts: endTs,
      cwd_initial: enriched.project_root,
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
      merge: { merge_strategy: 'gemini_session_versions' },
    }
    return { unit, summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length } }
  }
}

export { discoverGeminiChats } from './discover.js'
export type { GeminiChatHint } from './discover.js'
export type { GeminiMessage, GeminiSessionFile } from './types.js'
