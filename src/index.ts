// Public programmatic API. The CLI, TUI, and MCP server all sit on top of
// these primitives — nothing should bypass them.

export {
  initBundle,
  openBundle,
  openOrInitBundle,
  closeBundle,
  defaultBundlePath,
  type Bundle,
  type BundleManifest,
} from './core/bundle.js';

export { runMigrations, currentSchemaVersion } from './core/schema/migrate.js';
export { PROSA_PARSER_VERSION, PROSA_SCHEMA_VERSION } from './core/version.js';

export {
  putBytes,
  putJson,
  putText,
  getBytes,
  getJson,
  getText,
  getObjectMeta,
  type ObjectId,
  type ObjectMeta,
} from './core/cas/index.js';

export {
  startBatch,
  finishBatch,
  recordError,
  emptyCounts,
  type ImportBatch,
  type ImportCounts,
} from './core/ingest/batch.js';

export {
  registerSourceFile,
  type SourceFileRow,
  type RegisterResult,
} from './core/ingest/idempotency.js';

export type {
  SourceTool,
  Confidence,
  MessageRole,
  CanonicalToolType,
  EdgeType,
  ToolCallStatus,
  SessionRowFull,
} from './core/domain/types.js';

export {
  countSessions,
  listSessions,
  getSession,
  type SessionListFilters,
  type SessionRow,
  type SessionDetail,
  type SessionDetailEvent,
} from './services/sessions.js';

export { searchFullText, type SearchHit, type SearchOptions } from './services/search.js';
export {
  disableFts5Triggers,
  enableFts5Triggers,
  getSearchIndexStatus,
  getSearchIndexStatuses,
  markIndexesAfterImport,
  rebuildFts5Index,
  rebuildTantivyIndex,
  type SearchEngine,
  type SearchIndexStatus,
} from './services/indexing.js';
export {
  COMPILE_PROVIDERS,
  exportCompileParquet,
  getCompileProvider,
  resolveCompilePath,
  runCompileImports,
  type CompileImportSummary,
  type CompileProviderConfig,
  type ParquetCompileSummary,
  type ProviderCompileSummary,
  type TantivyCompileSummary,
} from './services/compile.js';
export {
  ANALYTICS_REPORTS,
  runAnalyticsReport,
  type AnalyticsReport,
  type AnalyticsReportFilters,
  type AnalyticsReportOptions,
} from './services/analytics.js';
export { exportSessionMarkdown } from './services/export/markdown.js';
export {
  ANALYTICS_VIEWS,
  exportBundleParquet,
  queryDuckDbParquet,
  PARQUET_TABLES,
  type AnalyticsView,
  type DuckDbQueryOptions,
  type DuckDbQueryResult,
  type ParquetExportOptions,
  type ParquetExportResult,
  type ParquetTable,
} from './services/export/parquet.js';

export { compileCodex, type CompileResult as CodexCompileResult } from './importers/codex/index.js';
export {
  compileClaude,
  type CompileResult as ClaudeCompileResult,
} from './importers/claude/index.js';
export {
  compileGemini,
  type CompileResult as GeminiCompileResult,
} from './importers/gemini/index.js';
export {
  compileCursor,
  type CompileResult as CursorCompileResult,
} from './importers/cursor/index.js';
export type { CompileLogger, CompileOptions } from './importers/compile-options.js';
