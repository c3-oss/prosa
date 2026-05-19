// Cursor Provider (v2) — minimal opaque-bytes slice.
//
// Cursor session content lives in a SQLite database at
// `<root>/<workspace>/<agent>/store.db`. The minimal first
// iteration treats each `store.db` as opaque bytes so the canonical
// raw-source invariant (I1) holds without pulling in a SQLite
// dependency. Emits one `SourceFileV2` + one `RawRecordV2` +
// one `SessionV2` per database. `timeline_confidence` is set to
// `'low'` because we cannot yet recover per-message ordering;
// per-row decoding lands in a follow-up iteration.

import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'

import { deriveRawRecordId, deriveSourceFileId, toHex } from '@c3-oss/prosa-types-v2'
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
import { discoverCursorStores } from './discover.js'

const SOURCE_TOOL = 'cursor' as const
const FILE_KIND = 'session_sqlite'

interface DiscoveredCursorFile extends DiscoveredSourceFile {
  workspace_id: string
  agent_id: string
}

export class CursorProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredCursorFile[] = []
    for await (const hint of discoverCursorStores(root)) {
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
        workspace_id: hint.workspaceId,
        agent_id: hint.agentId,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // CQ-070: the (workspace, agent) pair is the canonical logical
    // identifier for a Cursor session. Use exactly the same string
    // for the Reserve key AND the SessionV2 derivation
    // (`parseAndProject` recomputes `cursor:<ws>:<agent>` to derive
    // the session row id). Including `contentHash` in the logical
    // key would let a changed `store.db` for the same workspace/agent
    // bypass the old reservation while still targeting the same
    // session row.
    const enriched = file as DiscoveredCursorFile
    const ws = enriched.workspace_id ?? 'unknown-ws'
    const agent = enriched.agent_id ?? 'unknown-agent'
    return {
      logicalKey: new TextEncoder().encode(`cursor:${ws}:${agent}`),
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('cursor parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const enriched = file as DiscoveredCursorFile

    // One raw_record per database — we preserve the bytes opaquely.
    // Future iterations can swap `binary_only` to `parsed` when
    // per-row decoding lands without invalidating earlier sealed
    // raw_record ids (ordinal stays 0).
    const rawRecordId = deriveRawRecordId({
      source_tool: SOURCE_TOOL,
      source_file_id: file.source_file_id,
      ordinal: 0,
      record_kind: 'session_sqlite_row',
    })
    draft.raw_records.push({
      raw_record_id: rawRecordId,
      source_tool: SOURCE_TOOL,
      source_file_id: file.source_file_id,
      record_kind: 'session_sqlite_row',
      ordinal: 0,
      logical_offset: 0,
      logical_length: bytes.length,
      line_no: null,
      json_pointer: null,
      parser_status: 'binary_only',
      confidence: 'low',
      content_hash: contentHash,
      object_id: contentHash,
      decoded_object_id: null,
      created_at: input.createdAt,
    })

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

    // Logical session id derives from (workspace, agent, content_hash)
    // so re-importing the same database produces the same SessionV2.
    const logicalKey = `cursor:${enriched.workspace_id ?? 'unknown-ws'}:${enriched.agent_id ?? 'unknown-agent'}`
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(logicalKey))).slice(0, 32)}`
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: logicalKey,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary: null,
      start_ts: input.createdAt,
      end_ts: null,
      cwd_initial: null,
      git_branch_initial: null,
      model_first: null,
      model_last: null,
      status: null,
      // Cursor importer cannot recover precise per-message timing
      // until SQLite row decoding lands; mark accordingly.
      timeline_confidence: 'low',
      raw_record_id: rawRecordId,
    })

    const unit: LogicalImportUnit = {
      unit_id: input.identification.unit_id,
      source_tool: SOURCE_TOOL,
      logical_kind: 'session',
      source_file_ids: [file.source_file_id],
      raw_record_ids: [rawRecordId],
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
    return { unit, summary: { files: 1, sessions: 1, rawRecords: 1 } }
  }
}

export { discoverCursorStores } from './discover.js'
export type { CursorStoreHint } from './discover.js'
