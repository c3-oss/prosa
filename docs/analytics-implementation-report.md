# Relatorio de Implementacao: Analytics Parquet e DuckDB

Data: 2026-05-08

## Solicitacao Original

O pedido original foi implementar os pontos 1, 2 e 5 do roadmap de Parquet:

1. Views analiticas prontas: `session_facts`, `tool_usage_facts`, `error_facts`,
   `model_usage`, `project_activity`, juntando `sessions`, `turns`, `messages`,
   `tool_calls`, `tool_results` e `search_docs`.
2. Comandos de alto nivel: `prosa analytics tools`,
   `prosa analytics errors`, `prosa analytics projects` e, por decisao de
   planejamento, tambem `sessions` e `models`, usando DuckDB por baixo.
3. Receitas de queries: exemplos versionados para perguntas reais, como
   ferramentas mais usadas, comandos que falham, sessoes por projeto,
   latencia/duracao de tool calls, modelos por periodo e baixa confianca de
   timeline.

Durante o planejamento, ficou decidido que o v1 teria os cinco relatorios
`sessions`, `tools`, `errors`, `models` e `projects`, e que os comandos
`prosa analytics` teriam `--refresh` para exportar Parquet antes da consulta.

## Plano Aprovado

- Criar views DuckDB derivadas no setup de `queryDuckDbParquet()`, sem gravar
  novos arquivos Parquet derivados.
- Criar um servico de analytics com SQL fixo por relatorio e filtros comuns.
- Criar o comando `prosa analytics` com cinco subcomandos:
  `sessions`, `tools`, `errors`, `models`, `projects`.
- Suportar `--store`, `--parquet-dir`, `--refresh`, `--source`, `--since`,
  `--until`, `--limit` e `--output-format`.
- Adicionar filtros especificos para ferramentas, erros, modelos e projetos.
- Documentar a nova superficie no README, docs internas, roadmap e receitas.
- Cobrir com testes de servico Parquet e CLI.

## O Que Foi Executado

### Views Analiticas

`queryDuckDbParquet()` agora cria as views analiticas depois das views das
tabelas canonicas:

- `session_facts`: uma linha por sessao, com projeto, modelos, duracao,
  contagens de turns, mensagens, tool calls, tool results, erros e search docs.
- `tool_usage_facts`: uma linha por tool call, juntando sessao, projeto,
  status, duracao, erro, comando/path/query e preview.
- `error_facts`: visao unificada de erros de tool result, `import_errors` e
  `uncertainties`.
- `model_usage`: agregacao por modelo, source tool e projeto.
- `project_activity`: agregacao por source/projeto com sessoes, mensagens,
  ferramentas, erros e atividade recente.

### Servico e CLI

Foi criado um servico `runAnalyticsReport()` que executa relatorios fixos sobre
as views analiticas. A CLI ganhou:

```bash
prosa analytics sessions
prosa analytics tools
prosa analytics errors
prosa analytics models
prosa analytics projects
```

Todos os relatorios aceitam `--refresh`. Com essa flag, o comando executa
`exportBundleParquet()` antes da consulta. Sem `--refresh`, segue o contrato de
`prosa query duckdb`: o usuario precisa ter uma exportacao Parquet existente.

### Documentacao

- README atualizado com exemplos de `prosa analytics`.
- `docs/README.md` atualizado com link para receitas DuckDB.
- `docs/recipes/duckdb.md` criado com receitas copy-pasteable.
- `ROADMAP.md` e documentos de roadmap dos pontos 1, 2 e 5 atualizados para
  marcar implementacao inicial.
- Skill `prosa-search-export`, agentes especialistas Codex/Claude e guidance
  MCP atualizados para orientar o uso de analytics, views DuckDB e `--refresh`.

### Testes

Foram adicionadas verificacoes para:

- Disponibilidade das views analiticas via `queryDuckDbParquet()`.
- Contagens basicas de `session_facts`, `tool_usage_facts`, `model_usage`,
  `project_activity` e `error_facts`.
- Execucao de `prosa analytics sessions --refresh`.
- Execucao dos cinco relatorios `analytics` em JSON.

## Arquivos Criados

- `ROADMAP.md`
- `docs/recipes/duckdb.md`
- `docs/roadmap/analytics-commands.md`
- `docs/roadmap/analytics-views.md`
- `docs/roadmap/bi-friendly-datasets.md`
- `docs/roadmap/incremental-parquet-export.md`
- `docs/roadmap/query-recipes.md`
- `docs/roadmap/sanitized-parquet-exports.md`
- `src/cli/commands/analytics.ts`
- `src/services/analytics.ts`
- `test/cli/analytics.test.ts`

## Arquivos Alterados

- `README.md`
- `docs/README.md`
- `src/cli/main.ts`
- `src/index.ts`
- `src/services/export/parquet.ts`
- `test/services/parquet.test.ts`
- `AGENTS.md`
- `CLAUDE.md`
- `.codex/skills/prosa-search-export/SKILL.md`
- `.codex/skills/prosa-search-export/agents/openai.yaml`
- `.codex/agents/prosa-cli-search-specialist.toml`
- `.claude/agents/prosa-cli-search-specialist.md`
- `src/mcp/guidance.ts`

Tambem foram atualizados, dentro dos arquivos criados em `docs/roadmap/`, os
documentos `analytics-views.md`, `analytics-commands.md` e `query-recipes.md`
para refletir que os pontos correspondentes ja tem uma implementacao inicial.

## Arquivos Removidos

Nenhum arquivo foi removido.

## Validacao Executada

Comandos executados com sucesso:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Resultado final da suite completa:

- 14 arquivos de teste passaram.
- 47 testes passaram.

## Observacoes Relevantes

- A camada Parquet continua derivada. SQLite e CAS permanecem como fonte da
  verdade.
- As views analiticas sao criadas em tempo de consulta pelo DuckDB; nao ha nova
  camada fisica `parquet/analytics/`.
- `--refresh` e opt-in. Relatorios sem `--refresh` nao reexportam Parquet.
- O worktree ja continha outras alteracoes nao relacionadas, como arquivos de
  indexacao, compile, MCP e docs de arquitetura. Essas alteracoes foram
  preservadas e nao foram revertidas.
