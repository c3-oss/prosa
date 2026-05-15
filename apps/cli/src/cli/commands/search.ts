import { defaultBundlePath, searchFullText } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { withBundle } from '../bundle.js'
import { CliUserError } from '../errors.js'
import { printRows } from '../output.js'
import { parseOutputFormat, parseSearchEngine } from '../parsers.js'

/** Create the `prosa search` command for full-text session history queries. */
export function searchCommand(): Command {
  return new Command('search')
    .description('Full-text search across messages, tool calls and tool outputs.')
    .argument('<query>', 'FTS5 query string (supports MATCH syntax)')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--limit <n>', 'maximum hits', '50')
    .option('--engine <engine>', 'search engine: fts5|tantivy|remote-pg', 'fts5')
    .option('--local', 'read the local bundle even if this store is remote-authoritative', false)
    .option('--output-format <fmt>', 'interactive|table|json|csv', 'table')
    .action(
      async (
        query: string,
        options: { store: string; limit: string; engine: string; local: boolean; outputFormat: string },
        command: Command,
      ) => {
        const format = parseOutputFormat(options.outputFormat, 'table')
        const authority = await resolveReadAuthorityOrFailClosed({
          commandName: 'prosa search',
          storePath: options.store,
          forceLocal: options.local,
          remoteSupported: true,
        })
        if (authority.kind === 'remote') {
          const engineSource = command.getOptionValueSource('engine')
          if (engineSource !== 'default' && options.engine !== 'remote-pg') {
            throw new CliUserError(
              `remote-authoritative search uses the remote-pg engine; --engine ${options.engine} is local-only.\nUse --engine remote-pg, or add --local to query a local search index explicitly.`,
            )
          }
          const hits = await authority.client.searchQuery({
            q: query,
            limit: Number.parseInt(options.limit, 10),
          })
          const rows = hits.map((hit) => ({
            ...hit,
            session_id: hit.sessionId,
          }))
          printRows(rows, {
            format,
            columns: ['session_id', 'kind', 'snippet'],
            maxColumnWidths: { session_id: 12, kind: 12 },
            meta: { query, source: 'remote', engine: 'remote-pg', server: authority.entry.url, count: hits.length },
          })
          return
        }
        const engine = parseSearchEngine(options.engine)
        await withBundle(options.store, (bundle) => {
          const hits = searchFullText(bundle, {
            query,
            limit: Number.parseInt(options.limit, 10),
            engine,
          })
          printRows(hits, {
            format,
            columns: ['timestamp', 'role', 'tool_name', 'session_id', 'snippet'],
            maxColumnWidths: { session_id: 12, tool_name: 20 },
            meta: { query, engine, count: hits.length },
          })
        })
      },
    )
}
