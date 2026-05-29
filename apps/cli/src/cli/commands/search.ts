import { defaultBundlePath, searchFullText } from '@c3-oss/prosa-core'
import { Command } from 'commander'
import { resolveReadAuthorityOrFailClosed } from '../auth/routing.js'
import { withBundle } from '../bundle.js'
import { CliUserError } from '../errors.js'
import { printRows } from '../output.js'
import { parseOutputFormat, parseSearchEngine } from '../parsers.js'

/** Create the `prosa v1 search` command for full-text session history queries. */
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
          commandName: 'prosa v1 search',
          storePath: options.store,
          forceLocal: options.local,
          remoteSupported: true,
        })
        if (authority.kind === 'remote') {
          // CQ-005: remote search is fail-closed in v0. The CLI must not
          // pretend to serve remote search results; instead it surfaces a
          // clear error pointing the user back at --local.
          const engineSource = command.getOptionValueSource('engine')
          if (engineSource !== 'default' && options.engine !== 'remote-pg') {
            throw new CliUserError(
              `remote-authoritative search uses the remote-pg engine; --engine ${options.engine} is local-only.\nUse --engine remote-pg, or add --local to query a local search index explicitly.`,
            )
          }
          throw new CliUserError(
            'remote-authoritative search is unavailable in this prosa version (lane 04 FTS columns are not promoted yet). Re-run with --local to use the local Tantivy/FTS engine, or wait for the projection schema upgrade.',
          )
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
