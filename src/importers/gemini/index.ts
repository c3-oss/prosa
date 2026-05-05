import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Bundle } from '../../core/bundle.js';
import { sha256Hex } from '../../core/cas/hash.js';
import { type ObjectId, putBytes, putJson, putText } from '../../core/cas/index.js';
import { prepare, transactional } from '../../core/db.js';
import {
  artifactId,
  blockId,
  eventId as makeEventId,
  messageId as makeMessageId,
  projectId as makeProjectId,
  rawRecordId as makeRawRecordId,
  sessionId as makeSessionId,
  toolCallId as makeToolCallId,
  toolResultId as makeToolResultId,
} from '../../core/domain/ids.js';
import {
  type ImportBatch,
  type ImportCounts,
  emptyCounts,
  finishBatch,
  recordError,
  startBatch,
} from '../../core/ingest/batch.js';
import { registerSourceFile } from '../../core/ingest/idempotency.js';
import type { CompileLogger, CompileOptions } from '../compile-options.js';
import { type GeminiChatFile, discoverGeminiChats } from './discover.js';
import type {
  GeminiContentItem,
  GeminiMessage,
  GeminiSessionFile,
  GeminiToolCall,
  GeminiToolResult,
} from './types.js';

export interface CompileResult {
  batch: ImportBatch;
  counts: ImportCounts;
}

const PREVIEW_MAX = 4_000;

export async function compileGemini(
  bundle: Bundle,
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const logger = options.logger;
  const batch = startBatch(bundle, 'gemini', [root]);
  const counts = emptyCounts();
  logger?.info({ batch_id: batch.batch_id, root }, 'gemini batch started');
  try {
    for await (const file of discoverGeminiChats(root)) {
      counts.source_files_seen++;
      logger?.debug(
        {
          path: file.filePath,
          project_dir: file.projectDir,
          project_root: file.projectRoot,
        },
        'gemini source file discovered',
      );
      try {
        const fc = await compileGeminiFile(bundle, batch, file, logger);
        addCounts(counts, fc);
      } catch (error) {
        counts.errors++;
        logger?.warn(
          {
            err: error,
            path: file.filePath,
          },
          'gemini source file failed',
        );
        await recordError(bundle, batch.batch_id, {
          kind: 'gemini_file_failed',
          message: error instanceof Error ? error.message : String(error),
          payload: { path: file.filePath },
        });
      }
    }
    finishBatch(bundle, batch, counts, 'completed');
    logger?.info({ batch_id: batch.batch_id, counts }, 'gemini batch completed');
  } catch (error) {
    finishBatch(bundle, batch, counts, 'failed');
    logger?.error({ err: error, batch_id: batch.batch_id, counts }, 'gemini batch failed');
    throw error;
  }
  return { batch, counts };
}

interface FileCounts {
  source_files_imported: number;
  source_files_skipped: number;
  raw_records: number;
  sessions: number;
  events: number;
  messages: number;
  content_blocks: number;
  tool_calls: number;
  tool_results: number;
  artifacts: number;
  edges: number;
  errors: number;
}

function emptyFileCounts(): FileCounts {
  return {
    source_files_imported: 0,
    source_files_skipped: 0,
    raw_records: 0,
    sessions: 0,
    events: 0,
    messages: 0,
    content_blocks: 0,
    tool_calls: 0,
    tool_results: 0,
    artifacts: 0,
    edges: 0,
    errors: 0,
  };
}

function addCounts(target: ImportCounts, source: FileCounts): void {
  target.source_files_imported += source.source_files_imported;
  target.source_files_skipped += source.source_files_skipped;
  target.raw_records += source.raw_records;
  target.sessions += source.sessions;
  target.events += source.events;
  target.messages += source.messages;
  target.content_blocks += source.content_blocks;
  target.tool_calls += source.tool_calls;
  target.tool_results += source.tool_results;
  target.artifacts += source.artifacts;
  target.edges += source.edges;
  target.errors += source.errors;
}

interface PendingState {
  rawRecords: PendingRawRecord[];
  session: PendingSession | null;
  events: PendingEvent[];
  messages: PendingMessage[];
  blocks: PendingBlock[];
  toolCallsList: PendingToolCall[];
  toolResults: PendingToolResult[];
  artifacts: PendingArtifact[];
  searchDocs: PendingSearchDoc[];
  project: PendingProject | null;
}

interface PendingRawRecord {
  raw_record_id: string;
  source_file_id: string;
  ordinal: number | null;
  line_no: number | null;
  json_pointer: string | null;
  native_id: string | null;
  raw_object_id: ObjectId;
  decoded_json_object_id: ObjectId | null;
  parser_status: 'ok' | 'partial' | 'failed';
  confidence: 'high' | 'medium' | 'low';
  import_batch_id: string;
  record_kind: 'json_pointer' | 'jsonl_line';
}

interface PendingSession {
  session_id: string;
  source_session_id: string;
  start_ts: string | null;
  end_ts: string | null;
  cwd_initial: string | null;
  title: string | null;
  raw_record_id: string | null;
}

interface PendingProject {
  project_id: string;
  canonical_path: string | null;
  source_project_id: string;
}

interface PendingEvent {
  event_id: string;
  ordinal: number;
  source_event_id: string | null;
  event_type: string;
  source_type: string;
  subtype: string | null;
  timestamp: string | null;
  actor: string | null;
  payload_object_id: ObjectId | null;
  raw_record_id: string;
  confidence: 'high' | 'medium' | 'low';
}

interface PendingMessage {
  message_id: string;
  event_id: string | null;
  source_message_id: string | null;
  role: 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational';
  model: string | null;
  timestamp: string | null;
  ordinal: number;
  raw_record_id: string;
}

interface PendingBlock {
  block_id: string;
  message_id: string | null;
  event_id: string | null;
  ordinal: number;
  block_type: string;
  text_object_id: ObjectId | null;
  text_inline: string | null;
  visibility: 'default' | 'hidden_by_default' | 'audit_only';
  raw_record_id: string;
}

interface PendingToolCall {
  tool_call_id: string;
  message_id: string | null;
  event_id: string | null;
  source_call_id: string;
  tool_name: string;
  canonical_tool_type: string;
  args_object_id: ObjectId | null;
  command: string | null;
  cwd: string | null;
  path: string | null;
  query: string | null;
  timestamp_start: string | null;
  status: string | null;
  raw_record_id: string;
}

interface PendingToolResult {
  tool_result_id: string;
  tool_call_id: string;
  source_call_id: string;
  message_id: string | null;
  event_id: string | null;
  status: string | null;
  is_error: 0 | 1;
  output_object_id: ObjectId | null;
  preview: string | null;
  raw_record_id: string;
}

interface PendingArtifact {
  artifact_id: string;
  kind: string;
  path: string | null;
  logical_path: string | null;
  object_id: ObjectId | null;
  text_object_id: ObjectId | null;
  mime_type: string | null;
  size_bytes: number;
  created_ts: string | null;
  raw_record_id: string;
}

interface PendingSearchDoc {
  doc_id: string;
  entity_type: string;
  entity_id: string;
  timestamp: string | null;
  role: string | null;
  tool_name: string | null;
  canonical_tool_type: string | null;
  field_kind: string;
  text: string;
}

async function compileGeminiFile(
  bundle: Bundle,
  batch: ImportBatch,
  file: GeminiChatFile,
  logger?: CompileLogger,
): Promise<FileCounts> {
  const counts = emptyFileCounts();

  const { row: sourceFile, alreadyKnown } = await registerSourceFile(bundle, {
    sourceTool: 'gemini',
    absolutePath: path.resolve(file.filePath),
    fileKind: 'json',
    workspaceHint: file.projectDir,
  });
  if (alreadyKnown) {
    counts.source_files_skipped = 1;
    logger?.debug(
      { path: file.filePath, source_file_id: sourceFile.source_file_id },
      'gemini source file skipped',
    );
    return counts;
  }
  counts.source_files_imported = 1;
  logger?.debug(
    { path: file.filePath, source_file_id: sourceFile.source_file_id },
    'gemini source file registered',
  );

  const text = await readFile(file.filePath, 'utf8');
  const parsed = JSON.parse(text) as GeminiSessionFile;
  const fileObjectId = await putBytes(bundle, Buffer.from(text, 'utf8'), {
    mimeType: 'application/json',
    encoding: 'utf-8',
  });

  const rootRawRecordId = makeRawRecordId(sourceFile.source_file_id, 0, fileObjectId);
  const pending: PendingState = {
    rawRecords: [
      {
        raw_record_id: rootRawRecordId,
        source_file_id: sourceFile.source_file_id,
        ordinal: 0,
        line_no: null,
        json_pointer: '',
        native_id: parsed.sessionId ?? null,
        raw_object_id: fileObjectId,
        decoded_json_object_id: fileObjectId,
        parser_status: 'ok',
        confidence: 'high',
        import_batch_id: batch.batch_id,
        record_kind: 'json_pointer',
      },
    ],
    session: null,
    events: [],
    messages: [],
    blocks: [],
    toolCallsList: [],
    toolResults: [],
    artifacts: [],
    searchDocs: [],
    project: null,
  };

  const sourceSid = parsed.sessionId ?? path.basename(file.filePath, '.json');
  const sessionPk = makeSessionId('gemini', sourceSid);

  // Project linkage from .project_root, when present.
  if (file.projectRoot) {
    pending.project = {
      project_id: makeProjectId('gemini', parsed.projectHash ?? file.projectDir),
      canonical_path: file.projectRoot,
      source_project_id: parsed.projectHash ?? file.projectDir,
    };
  }

  const start = parsed.startTime ?? null;
  const end = parsed.lastUpdated ?? null;
  pending.session = {
    session_id: sessionPk,
    source_session_id: sourceSid,
    start_ts: start,
    end_ts: end,
    cwd_initial: file.projectRoot,
    title: parsed.summary ?? null,
    raw_record_id: rootRawRecordId,
  };

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    await processMessage(
      bundle,
      sessionPk,
      sourceFile.source_file_id,
      i,
      msg,
      batch.batch_id,
      pending,
    );
  }

  buildSearchDocs(pending);

  transactional(bundle.db, () => {
    flushPending(bundle, pending);
  });

  counts.raw_records = pending.rawRecords.length;
  counts.sessions = pending.session ? 1 : 0;
  counts.events = pending.events.length;
  counts.messages = pending.messages.length;
  counts.content_blocks = pending.blocks.length;
  counts.tool_calls = pending.toolCallsList.length;
  counts.tool_results = pending.toolResults.length;
  counts.artifacts = pending.artifacts.length;
  logger?.debug(
    { path: file.filePath, source_file_id: sourceFile.source_file_id, counts },
    'gemini source file imported',
  );
  return counts;
}

async function processMessage(
  bundle: Bundle,
  sessionId: string,
  sourceFileId: string,
  index: number,
  msg: GeminiMessage,
  batchId: string,
  pending: PendingState,
): Promise<void> {
  const ordinal = index + 1;
  const ts = msg.timestamp ?? null;

  const payloadId = await putJson(bundle, msg);
  // Use the JSON pointer as a stable per-record locator inside the file.
  const pointer = `/messages/${index}`;
  // Hash includes pointer so two entries with identical content but different
  // positions get distinct raw_record_ids.
  const rawObjectIdInput = sha256Hex(`${pointer}\n${JSON.stringify(msg)}`);
  const rawObjectId: ObjectId = `blake3:${rawObjectIdInput}`;
  void rawObjectId;
  const rawRecordId = makeRawRecordId(sourceFileId, ordinal, payloadId);

  pending.rawRecords.push({
    raw_record_id: rawRecordId,
    source_file_id: sourceFileId,
    ordinal,
    line_no: null,
    json_pointer: pointer,
    native_id: msg.id ?? null,
    raw_object_id: payloadId,
    decoded_json_object_id: payloadId,
    parser_status: 'ok',
    confidence: 'high',
    import_batch_id: batchId,
    record_kind: 'json_pointer',
  });

  const kind = msg.type ?? 'unknown';

  if (kind === 'user' || kind === 'gemini') {
    const role: PendingMessage['role'] = kind === 'user' ? 'user' : 'assistant';
    const messageId = makeMessageId(sessionId, ordinal, msg.id ?? null);
    const eventId = makeEventId(sessionId, ordinal, 'message');

    pending.events.push({
      event_id: eventId,
      ordinal,
      source_event_id: msg.id ?? null,
      event_type: 'message',
      source_type: kind,
      subtype: null,
      timestamp: ts,
      actor: role,
      payload_object_id: payloadId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    });

    pending.messages.push({
      message_id: messageId,
      event_id: eventId,
      source_message_id: msg.id ?? null,
      role,
      model: role === 'assistant' ? (msg.model ?? null) : null,
      timestamp: ts,
      ordinal,
      raw_record_id: rawRecordId,
    });

    // Content blocks.
    const content = msg.content;
    if (typeof content === 'string') {
      await pushTextBlock(bundle, pending, messageId, 0, 'text', content, rawRecordId);
    } else if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const item = content[i] as GeminiContentItem | undefined;
        if (!item) continue;
        const t = item.text ?? '';
        await pushTextBlock(bundle, pending, messageId, i, item.type ?? 'text', t, rawRecordId);
      }
    }

    // Thoughts → audit-only blocks (don't pollute search by default).
    const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts : [];
    for (let i = 0; i < thoughts.length; i++) {
      const th = thoughts[i];
      if (!th) continue;
      const text = [th.subject, th.description].filter(Boolean).join('\n\n');
      await pushTextBlock(
        bundle,
        pending,
        messageId,
        100 + i,
        'thinking',
        text,
        rawRecordId,
        'hidden_by_default',
      );
    }

    // Tool calls.
    const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      if (!tc) continue;
      await processToolCall(bundle, sessionId, messageId, eventId, i, tc, rawRecordId, pending);
    }
    return;
  }

  if (kind === 'info' || kind === 'error') {
    const eventId = makeEventId(sessionId, ordinal, kind);
    pending.events.push({
      event_id: eventId,
      ordinal,
      source_event_id: msg.id ?? null,
      event_type: kind === 'error' ? 'error' : 'system_operational',
      source_type: kind,
      subtype: null,
      timestamp: ts,
      actor: 'system',
      payload_object_id: payloadId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    });
    return;
  }

  // Unknown type — keep as operational event.
  pending.events.push({
    event_id: makeEventId(sessionId, ordinal, `unknown.${kind}`),
    ordinal,
    source_event_id: msg.id ?? null,
    event_type: 'system_operational',
    source_type: kind,
    subtype: null,
    timestamp: ts,
    actor: 'system',
    payload_object_id: payloadId,
    raw_record_id: rawRecordId,
    confidence: 'high',
  });
}

async function pushTextBlock(
  bundle: Bundle,
  pending: PendingState,
  messageId: string,
  blockOrdinal: number,
  blockType: string,
  text: string,
  rawRecordId: string,
  visibility: 'default' | 'hidden_by_default' | 'audit_only' = 'default',
): Promise<void> {
  if (!text) return;
  const overflowId = text.length > PREVIEW_MAX ? await putText(bundle, text) : null;
  pending.blocks.push({
    block_id: blockId(messageId, blockOrdinal),
    message_id: messageId,
    event_id: null,
    ordinal: blockOrdinal,
    block_type: blockType,
    text_object_id: overflowId,
    text_inline: text.slice(0, PREVIEW_MAX),
    visibility,
    raw_record_id: rawRecordId,
  });
}

async function processToolCall(
  bundle: Bundle,
  sessionId: string,
  messageId: string,
  eventId: string,
  index: number,
  tc: GeminiToolCall,
  rawRecordId: string,
  pending: PendingState,
): Promise<void> {
  const sourceCallId = tc.id ?? `${messageId}:${index}`;
  const toolName = tc.name ?? 'unknown';
  const toolCallId = makeToolCallId(sessionId, sourceCallId);
  const argsObjectId = tc.args ? await putJson(bundle, tc.args) : null;

  pending.toolCallsList.push({
    tool_call_id: toolCallId,
    message_id: messageId,
    event_id: eventId,
    source_call_id: sourceCallId,
    tool_name: toolName,
    canonical_tool_type: canonicalToolType(toolName),
    args_object_id: argsObjectId,
    command: typeof tc.args?.command === 'string' ? (tc.args.command as string) : null,
    cwd: typeof tc.args?.dir_path === 'string' ? (tc.args.dir_path as string) : null,
    path:
      typeof tc.args?.file_path === 'string'
        ? (tc.args.file_path as string)
        : typeof tc.args?.path === 'string'
          ? (tc.args.path as string)
          : null,
    query: typeof tc.args?.query === 'string' ? (tc.args.query as string) : null,
    timestamp_start: tc.timestamp ?? null,
    status: tc.status ?? null,
    raw_record_id: rawRecordId,
  });

  const isError = tc.status === 'error' ? 1 : 0;
  const resultText = renderToolResultText(tc.result);
  const overflowId = resultText.length > PREVIEW_MAX ? await putText(bundle, resultText) : null;

  pending.toolResults.push({
    tool_result_id: makeToolResultId(sessionId, sourceCallId),
    tool_call_id: toolCallId,
    source_call_id: sourceCallId,
    message_id: messageId,
    event_id: eventId,
    status: tc.status ?? null,
    is_error: isError,
    output_object_id: overflowId,
    preview: resultText.slice(0, PREVIEW_MAX) || null,
    raw_record_id: rawRecordId,
  });

  // resultDisplay diffs become artifacts.
  if (tc.resultDisplay && typeof tc.resultDisplay === 'object') {
    const rd = tc.resultDisplay;
    if (rd.fileDiff || rd.filePath) {
      const diffText = rd.fileDiff ?? '';
      const diffId = diffText ? await putText(bundle, diffText, { mimeType: 'text/x-diff' }) : null;
      pending.artifacts.push({
        artifact_id: artifactId(sessionId, 'gemini', `${toolCallId}:diff`),
        kind: 'diff',
        path: rd.filePath ?? null,
        logical_path: rd.fileName ?? rd.filePath ?? null,
        object_id: diffId,
        text_object_id: diffId,
        mime_type: 'text/x-diff',
        size_bytes: diffText.length,
        created_ts: tc.timestamp ?? null,
        raw_record_id: rawRecordId,
      });
    }
  }
}

function renderToolResultText(result: GeminiToolResult[] | undefined): string {
  if (!Array.isArray(result)) return '';
  const parts: string[] = [];
  for (const r of result) {
    if (r.text) {
      parts.push(r.text);
      continue;
    }
    if (r.functionResponse?.response) {
      const rr = r.functionResponse.response;
      if (rr.error != null)
        parts.push(typeof rr.error === 'string' ? rr.error : JSON.stringify(rr.error));
      else if (rr.output != null)
        parts.push(typeof rr.output === 'string' ? rr.output : JSON.stringify(rr.output));
    }
  }
  return parts.join('\n');
}

function canonicalToolType(toolName: string): string {
  switch (toolName) {
    case 'run_shell_command':
    case 'shell':
    case 'shell_command':
      return 'shell';
    case 'read_file':
    case 'read_many_files':
      return 'read_file';
    case 'write_file':
      return 'write_file';
    case 'replace':
    case 'search_replace':
      return 'edit_file';
    case 'list_directory':
    case 'glob':
    case 'grep_search':
    case 'search_file_content':
      return 'search_file';
    case 'google_web_search':
      return 'web_search';
    case 'codebase_investigator':
      return 'subagent';
    default:
      return toolName.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

function buildSearchDocs(pending: PendingState): void {
  const sessionId = pending.session?.session_id ?? null;
  if (!sessionId) return;
  const blocksByMsg = new Map<string, PendingBlock[]>();
  for (const b of pending.blocks) {
    if (!b.message_id) continue;
    if (b.visibility === 'hidden_by_default') continue;
    const list = blocksByMsg.get(b.message_id) ?? [];
    list.push(b);
    blocksByMsg.set(b.message_id, list);
  }
  for (const m of pending.messages) {
    const text = (blocksByMsg.get(m.message_id) ?? [])
      .map((b) => b.text_inline ?? '')
      .join('\n')
      .trim();
    if (!text) continue;
    pending.searchDocs.push({
      doc_id: `msg:${m.message_id}`,
      entity_type: 'message',
      entity_id: m.message_id,
      timestamp: m.timestamp,
      role: m.role,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: m.role === 'user' ? 'user_prompt' : 'assistant_text',
      text,
    });
  }
  for (const tc of pending.toolCallsList) {
    if (tc.command) {
      pending.searchDocs.push({
        doc_id: `tc:cmd:${tc.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: tc.tool_call_id,
        timestamp: tc.timestamp_start,
        role: null,
        tool_name: tc.tool_name,
        canonical_tool_type: tc.canonical_tool_type,
        field_kind: 'command',
        text: tc.command,
      });
    }
    if (tc.path) {
      pending.searchDocs.push({
        doc_id: `tc:path:${tc.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: tc.tool_call_id,
        timestamp: tc.timestamp_start,
        role: null,
        tool_name: tc.tool_name,
        canonical_tool_type: tc.canonical_tool_type,
        field_kind: 'file_path',
        text: tc.path,
      });
    }
  }
  for (const tr of pending.toolResults) {
    if (!tr.preview) continue;
    pending.searchDocs.push({
      doc_id: `tr:preview:${tr.tool_result_id}`,
      entity_type: 'tool_result',
      entity_id: tr.tool_result_id,
      timestamp: null,
      role: null,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: tr.is_error ? 'error' : 'tool_result',
      text: tr.preview,
    });
  }
}

function flushPending(bundle: Bundle, pending: PendingState): void {
  if (!pending.session) return;

  const insertRaw = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO raw_records (
       raw_record_id, source_file_id, source_tool, record_kind, ordinal,
       line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id,
       parser_status, confidence, import_batch_id
     ) VALUES (?, ?, 'gemini', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of pending.rawRecords) {
    insertRaw.run(
      r.raw_record_id,
      r.source_file_id,
      r.record_kind,
      r.ordinal,
      r.line_no,
      r.json_pointer,
      r.native_id,
      r.raw_object_id,
      r.decoded_json_object_id,
      r.parser_status,
      r.confidence,
      r.import_batch_id,
    );
  }

  if (pending.project) {
    prepare(
      bundle.db,
      `INSERT OR IGNORE INTO projects (
         project_id, canonical_path, path_hash, source_tool, source_project_id,
         display_name, created_at
       ) VALUES (?, ?, ?, 'gemini', ?, NULL, ?)`,
    ).run(
      pending.project.project_id,
      pending.project.canonical_path,
      pending.project.canonical_path
        ? sha256Hex(pending.project.canonical_path).slice(0, 32)
        : null,
      pending.project.source_project_id,
      new Date().toISOString(),
    );
  }

  prepare(
    bundle.db,
    `INSERT OR REPLACE INTO sessions (
       session_id, source_tool, source_session_id, project_id, parent_session_id,
       is_subagent, agent_role, agent_nickname, title, summary,
       start_ts, end_ts, cwd_initial, git_branch_initial,
       model_first, model_last, status, timeline_confidence, raw_record_id
     ) VALUES (?, 'gemini', ?, ?, NULL, 0, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL, NULL, 'completed', 'high', ?)`,
  ).run(
    pending.session.session_id,
    pending.session.source_session_id,
    pending.project?.project_id ?? null,
    pending.session.title,
    pending.session.start_ts,
    pending.session.end_ts,
    pending.session.cwd_initial,
    pending.session.raw_record_id,
  );

  const insertEvent = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO events (
       event_id, session_id, turn_id, source_event_id, event_type, source_type,
       subtype, timestamp, ordinal, actor, payload_object_id, raw_record_id,
       confidence, is_derived
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  for (const e of pending.events) {
    insertEvent.run(
      e.event_id,
      pending.session.session_id,
      e.source_event_id,
      e.event_type,
      e.source_type,
      e.subtype,
      e.timestamp,
      e.ordinal,
      e.actor,
      e.payload_object_id,
      e.raw_record_id,
      e.confidence,
    );
  }

  const insertMsg = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO messages (
       message_id, session_id, turn_id, event_id, source_message_id, role,
       author_name, model, timestamp, ordinal, parent_message_id, request_id,
       status, raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`,
  );
  for (const m of pending.messages) {
    insertMsg.run(
      m.message_id,
      pending.session.session_id,
      m.event_id,
      m.source_message_id,
      m.role,
      m.model,
      m.timestamp,
      m.ordinal,
      m.raw_record_id,
    );
  }

  const insertBlock = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO content_blocks (
       block_id, message_id, event_id, session_id, ordinal, block_type,
       text_object_id, text_inline, mime_type, token_count, is_error,
       is_redacted, visibility, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)`,
  );
  for (const b of pending.blocks) {
    insertBlock.run(
      b.block_id,
      b.message_id,
      b.event_id,
      pending.session.session_id,
      b.ordinal,
      b.block_type,
      b.text_object_id,
      b.text_inline,
      b.visibility,
      b.raw_record_id,
    );
  }

  const insertCall = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_calls (
       tool_call_id, session_id, turn_id, message_id, event_id,
       source_call_id, tool_name, canonical_tool_type, args_object_id,
       command, cwd, path, query, timestamp_start, timestamp_end, status,
       raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  );
  for (const c of pending.toolCallsList) {
    insertCall.run(
      c.tool_call_id,
      pending.session.session_id,
      c.message_id,
      c.event_id,
      c.source_call_id,
      c.tool_name,
      c.canonical_tool_type,
      c.args_object_id,
      c.command,
      c.cwd,
      c.path,
      c.query,
      c.timestamp_start,
      c.status,
      c.raw_record_id,
    );
  }

  const insertResult = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_results (
       tool_result_id, tool_call_id, session_id, message_id, event_id,
       source_call_id, status, is_error, exit_code, duration_ms,
       stdout_object_id, stderr_object_id, output_object_id, preview, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  );
  for (const r of pending.toolResults) {
    insertResult.run(
      r.tool_result_id,
      r.tool_call_id,
      pending.session.session_id,
      r.message_id,
      r.event_id,
      r.source_call_id,
      r.status,
      r.is_error,
      r.output_object_id,
      r.preview,
      r.raw_record_id,
    );
  }

  const insertArtifact = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO artifacts (
       artifact_id, session_id, project_id, source_tool, kind, path,
       logical_path, object_id, text_object_id, mime_type, size_bytes,
       created_ts, raw_record_id
     ) VALUES (?, ?, ?, 'gemini', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of pending.artifacts) {
    insertArtifact.run(
      a.artifact_id,
      pending.session.session_id,
      pending.project?.project_id ?? null,
      a.kind,
      a.path,
      a.logical_path,
      a.object_id,
      a.text_object_id,
      a.mime_type,
      a.size_bytes,
      a.created_ts,
      a.raw_record_id,
    );
  }

  const insertSearch = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO search_docs (
       doc_id, entity_type, entity_id, session_id, project_id, timestamp,
       role, tool_name, canonical_tool_type, field_kind, text
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of pending.searchDocs) {
    insertSearch.run(
      d.doc_id,
      d.entity_type,
      d.entity_id,
      pending.session.session_id,
      pending.project?.project_id ?? null,
      d.timestamp,
      d.role,
      d.tool_name,
      d.canonical_tool_type,
      d.field_kind,
      d.text,
    );
  }
}
