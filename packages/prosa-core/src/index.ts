/**
 * Public programmatic API for opening prosa stores, importing native agent
 * histories, querying canonical sessions, and exporting derived datasets.
 *
 * The CLI, TUI, and MCP server sit on top of these primitives. Callers that
 * embed prosa should prefer this module over reaching into internal paths.
 *
 * @packageDocumentation
 */

export {
  BundleNotInitializedError,
  initBundle,
  openBundle,
  openOrInitBundle,
  closeBundle,
  defaultBundlePath,
  type Bundle,
  type BundleManifest,
} from './core/bundle.js'

export { runMigrations, currentSchemaVersion, type MigrationResult } from './core/schema/migrate.js'
export { PROSA_PARSER_VERSION, PROSA_SCHEMA_VERSION } from './core/version.js'
export { SOURCE_TOOLS } from './core/domain/types.js'
export type { Compression } from './core/cas/compress.js'

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
  type PutOptions,
} from './core/cas/index.js'

export {
  startBatch,
  finishBatch,
  recordError,
  emptyCounts,
  type ImportBatch,
  type ImportCounts,
} from './core/ingest/batch.js'

export {
  registerSourceFile,
  type SourceFileRow,
  type RegisterResult,
} from './core/ingest/idempotency.js'

export type {
  SourceTool,
  Confidence,
  MessageRole,
  CanonicalToolType,
  EdgeType,
  ToolCallStatus,
  SessionRowFull,
} from './core/domain/types.js'

export {
  countSessions,
  listSessions,
  getSession,
  type SessionListFilters,
  type SessionRow,
  type SessionDetail,
  type SessionDetailEvent,
} from './services/sessions.js'

export { searchFullText, type SearchHit, type SearchOptions } from './services/search.js'
export {
  disableFts5Triggers,
  enableFts5Triggers,
  getSearchIndexStatus,
  getSearchIndexStatuses,
  markIndexesAfterImport,
  rebuildFts5Index,
  rebuildTantivyIndex,
  type RebuildTantivyOptions,
  type SearchEngine,
  type SearchIndexStatus,
} from './services/indexing.js'
export {
  COMPILE_PROVIDERS,
  exportCompileParquet,
  getCompileProvider,
  resolveCompilePath,
  runCompileImports,
  type CompileImportOptions,
  type CompileImportSummary,
  type CompileProviderConfig,
  type CompileResult,
  type ExportCompileParquetOptions,
  type ParquetCompileSummary,
  type ProviderCompileSummary,
  type TantivyCompileSummary,
} from './services/compile.js'
export {
  ANALYTICS_REPORTS,
  runAnalyticsReport,
  runAnalyticsReportFromBundle,
  type AnalyticsBundleReportOptions,
  type AnalyticsDialect,
  type AnalyticsReport,
  type AnalyticsReportFilters,
  type AnalyticsReportOptions,
} from './services/analytics.js'
export {
  runDoctor,
  shouldRecommendVacuum,
  type CheckResult,
  type CheckStatus,
  type DoctorOptions,
  type DoctorReport,
} from './services/doctor.js'
export {
  listToolCalls,
  type ToolCallEntity,
  type ToolCallEvidence,
  type ToolCallFilters,
} from './services/tool_calls.js'
export { exportSessionMarkdown } from './services/export/markdown.js'
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
} from './services/export/parquet.js'

export { compileCodex, type CompileResult as CodexCompileResult } from './importers/codex/index.js'
export {
  compileClaude,
  type CompileResult as ClaudeCompileResult,
} from './importers/claude/index.js'
export {
  compileGemini,
  type CompileResult as GeminiCompileResult,
} from './importers/gemini/index.js'
export {
  compileCursor,
  type CompileResult as CursorCompileResult,
} from './importers/cursor/index.js'
export type { CompileLogger, CompileOptions } from './importers/compile-options.js'

export { PROSA_MCP_INSTRUCTIONS } from './mcp/guidance.js'
export {
  listenMcpServer,
  listenMcpStdioServer,
  type McpServerOptions,
  type McpStdioServerOptions,
  type RunningServer,
  type RunningStdioServer,
} from './mcp/server.js'
export { registerProsaTools, type ProsaToolOptions } from './mcp/tools.js'
