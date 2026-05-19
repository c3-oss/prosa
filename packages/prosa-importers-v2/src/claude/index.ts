// Claude Code Provider (v2).
//
// First iteration scope mirrors the Codex provider: discover JSONL files
// under `<root>/<project-slug>/`, cheap-identify by the first record's
// `sessionId` (or `agentId` for subagents), and emit a minimal
// `LogicalImportUnit` with one `SessionV2` + one `SourceFileV2` + one
// `RawRecordV2` per JSONL line. Subagent files are marked
// `is_subagent: true`. Parent-session linking is left to
// `GraphResolver` after the orchestrator collects all units.
//
// Out of scope this iteration (intentionally deferred):
//   - Per-record TurnV2 / MessageV2 / ContentBlockV2 / ToolCallV2 /
//     ToolResultV2 projection from `message.content` blocks.
//   - Subagent meta-file parsing for `agentType` / `description`.
//   - Cross-session sidechain edges (`isSidechain`).
// Those land as the next Claude commits.

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
import { discoverClaudeFiles } from './discover.js'
import type { ClaudeRecord } from './types.js'

const SOURCE_TOOL = 'claude' as const
const FILE_KIND = 'session_jsonl'

/** Source-file id derivation key: includes the path so two copies of the same
 *  bytes in different projects/agents are distinct artifacts. */
function deriveClaudeSourceFileId(filePath: string, contentHash: string): string {
  return deriveSourceFileId({
    source_tool: SOURCE_TOOL,
    path: normalize(filePath),
    content_hash: contentHash,
  })
}

export class ClaudeProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredSourceFile[] = []
    for await (const hint of discoverClaudeFiles(root)) {
      const bytes = await readFile(hint.filePath)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      out.push({
        source_file_id: deriveClaudeSourceFileId(hint.filePath, contentHash),
        path: hint.filePath,
        source_tool: SOURCE_TOOL,
        file_kind: hint.isSubagent ? 'session_jsonl_subagent' : FILE_KIND,
        bytes,
      })
    }
    return out
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // Walk just enough of the file to find the first record carrying a
    // sessionId. Subagent files share their parent session's sessionId
    // but have a distinct agentId; we incorporate both so the logical
    // key dedupes correctly.
    const bytes = file.bytes ?? (await readFile(file.path))
    const text = new TextDecoder().decode(bytes)
    let sessionId: string | null = null
    let agentId: string | null = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: ClaudeRecord
      try {
        rec = JSON.parse(trimmed) as ClaudeRecord
      } catch {
        continue
      }
      if (typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
        sessionId = rec.sessionId
      }
      if (typeof rec.agentId === 'string' && rec.agentId.length > 0) {
        agentId = rec.agentId
      }
      if (sessionId !== null) break
    }
    const logicalKey =
      sessionId !== null
        ? new TextEncoder().encode(agentId !== null ? `claude:${sessionId}:agent:${agentId}` : `claude:${sessionId}`)
        : new TextEncoder().encode(`claude:src:${file.source_file_id}`)
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) {
      throw new Error('claude parseAndProject: no input file')
    }
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const text = new TextDecoder().decode(bytes)
    const lines = text.split('\n')
    const rawRecordIds: string[] = []
    let ordinal = 0
    let logicalOffset = 0
    let sessionId: string | null = null
    let agentId: string | null = null
    let sessionStartTs: string | null = null
    let model: string | null = null
    let cwd: string | null = null
    let gitBranch: string | null = null
    let isSubagent = file.file_kind === 'session_jsonl_subagent'

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!line) {
        logicalOffset += 1
        continue
      }
      const lineByteLength = new TextEncoder().encode(line).length
      let rec: ClaudeRecord | null = null
      try {
        rec = JSON.parse(line) as ClaudeRecord
      } catch {
        rec = null
      }
      if (rec) {
        if (sessionId === null && typeof rec.sessionId === 'string') sessionId = rec.sessionId
        if (agentId === null && typeof rec.agentId === 'string') agentId = rec.agentId
        if (rec.isSidechain === true) isSubagent = true
        if (sessionStartTs === null && typeof rec.timestamp === 'string' && isValidCanonicalTimestamp(rec.timestamp)) {
          sessionStartTs = canonicalTimestamp(rec.timestamp)
        }
        if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd
        if (gitBranch === null && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
        if (model === null && typeof rec.message?.model === 'string') model = rec.message.model
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
        parser_status: rec ? 'parsed' : 'unparseable',
        confidence: rec ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
      ordinal += 1
      logicalOffset += lineByteLength + 1
    }

    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: isSubagent ? 'session_jsonl_subagent' : FILE_KIND,
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

    const sessionLogicalId = sessionId ?? input.identification.unit_id
    // For subagent files, include the agentId so the same parent
    // sessionId across main + subagent files derives a distinct session.
    const sessionKeyMaterial =
      agentId !== null ? `claude:${sessionLogicalId}:agent:${agentId}` : `claude:${sessionLogicalId}`
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(sessionKeyMaterial))).slice(0, 32)}`
    const firstRawRecordId = rawRecordIds[0] ?? null
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: isSubagent ? 'unresolved' : 'unresolved',
      is_subagent: isSubagent,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary: null,
      start_ts: sessionStartTs ?? input.createdAt,
      end_ts: null,
      cwd_initial: cwd,
      git_branch_initial: gitBranch,
      model_first: model,
      model_last: model,
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
      summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length },
    }
  }
}

export { discoverClaudeFiles } from './discover.js'
export type { ClaudeFileHint } from './discover.js'
export type { ClaudeMessage, ClaudeRecord } from './types.js'
