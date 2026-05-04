# Proposta de uso: prosa para unificar sessões de agentes

## Ideia

Criar uma aplicação chamada **prosa** para converter históricos de sessões de
várias ferramentas de agentes em um único formato canônico, chamado aqui de
**W**.

**prosa** deve ser três interfaces sobre o mesmo núcleo:

- **CLI**: comandos scriptáveis para importar, consultar, exportar e manter o
  índice.
- **TUI**: interface terminal interativa para navegar sessões, timelines,
  buscas, tool calls, artifacts e exports.
- **MCP server**: servidor MCP local, via **HTTP streamable**, para permitir que
  outros agentes consultem o acervo de sessões.

A aplicação funcionaria como um compilador/importador:

```text
Cursor Agent     \
Codex CLI         \
Claude Code        -> prosa compile -> formato W
Gemini CLI       /
```

Depois, o formato **W** serviria como base para consulta, leitura, auditoria,
exportação e análise de todas as conversas com agentes em um único lugar.

## Problema

Hoje, cada ferramenta guarda sessões em um formato próprio:

- Cursor Agent usa bancos SQLite `store.db` com blobs e metadados.
- Codex CLI usa arquivos JSONL em árvore por data.
- Claude Code usa JSONL por projeto, subagentes, tool-results e índices
  auxiliares.
- Gemini CLI usa JSON em `~/.gemini/tmp`, com chats, logs e metadados de
  projeto.

Esses formatos são úteis para cada ferramenta individualmente, mas dificultam:

- pesquisar histórico completo entre ferramentas;
- cruzar informações de sessões diferentes;
- auditar comandos e arquivos alterados;
- ver timelines completas;
- relacionar sessões principais e subagentes;
- exportar conversas para formatos humanos como Markdown;
- construir dashboards, filtros e consultas rápidas.

## Objetivo

**prosa** deve transformar sessões de múltiplas origens em um formato **W**
único, eficiente e consultável, e oferecer três formas de interação com esse
acervo: CLI, TUI e MCP server.

Exemplo conceitual:

```bash
prosa compile \
  --cursor ~/.cursor/chats \
  --codex ~/.codex/sessions \
  --claude ~/.claude/projects \
  --gemini ~/.gemini/tmp \
  --out ~/.aitrail
```

Depois:

```bash
prosa search "termo de busca"
prosa sessions --project movaincentivo --since 2026-01-01
prosa tools --name Shell --errors
prosa files --touched src/app.ts
prosa export session <session-id> --format markdown
```

Exemplo de TUI:

```bash
prosa tui
```

Exemplo de MCP server:

```bash
prosa mcp serve --transport http --host 127.0.0.1 --port 7331
```

## Formato W

O formato **W** deve ser um armazenamento local-first, reprocessável e
performático, capaz de representar:

- sessões;
- turnos;
- mensagens;
- blocos de conteúdo;
- system prompts;
- respostas de assistente;
- chamadas de ferramenta;
- resultados de ferramenta;
- comandos shell;
- arquivos lidos;
- arquivos alterados;
- erros;
- eventos operacionais;
- subagentes;
- artifacts externos;
- relações entre eventos;
- dados brutos originais.

O formato deve preservar a origem dos dados:

```text
source_tool: cursor | codex | claude | gemini
source_path: caminho original
source_id: id original da sessão/mensagem/blob/evento
raw_hash: hash do registro bruto
```

## Consultas desejadas

A partir de **W**, quero conseguir consultar perguntas como:

- Quais conversas tive sobre um tema específico?
- Em quais sessões um arquivo foi lido ou alterado?
- Quais comandos shell foram executados?
- Quais comandos falharam?
- Quais modelos foram usados em cada projeto?
- Quais sessões envolveram subagentes?
- Quais sessões rodaram em determinada branch Git?
- Onde aparecem determinados system prompts?
- Quais tool calls produziram erro?
- Quais conversas geraram diffs ou patches?
- Quais sessões são relacionadas ao mesmo projeto, path ou arquivo?
- O que aconteceu em determinada janela de tempo?

## Exportação

**prosa** deve conseguir exportar dados de **W** para formatos legíveis:

```bash
prosa export session <session-id> --format markdown
prosa export search "termo" --format markdown
prosa export project <project-id> --format markdown
```

O Markdown exportado deve ser fácil de ler e preservar metadados úteis, como:

- ferramenta de origem;
- data;
- projeto/cwd;
- modelo;
- branch;
- mensagens de usuário;
- respostas do assistente;
- chamadas de ferramenta resumidas;
- resultados relevantes;
- erros;
- links ou referências para artifacts grandes.

## TUI

A TUI da **prosa** deve ser uma interface terminal interativa para explorar o
formato **W** sem precisar lembrar todos os comandos da CLI.

Referências locais importantes:

```text
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer
```

### Referência: foreach-agent

O projeto `foreach-agent` é uma boa referência para uma TUI multi-tela em Ink
com estado persistido, execução/monitoramento e comandos headless equivalentes.

Arquivos importantes:

```text
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/package.json
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/README.md
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/main.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/cli.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/App.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/components/InputOverlay.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/components/TemplatesScreen.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/components/RunsHistoryScreen.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/components/MonitorScreen.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/components/TaskLogScreen.tsx
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/hooks/useInputMode.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/hooks/useStore.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/tui/hooks/useRunExecution.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/services/query-filter.ts
/Users/upsetbit/Projects/c3/c3-oss/sk.js/apps/foreach-agent/src/services/store.ts
```

Pontos relevantes observados:

- Usa `ink` e `react` para renderizar a TUI.
- O `package.json` expõe um binário `foreach-agent`.
- A aplicação tem modo interativo, modo headless CLI e API programática.
- O comando padrão é a TUI; `foreach-agent tui` abre explicitamente a TUI.
- `src/main.ts` faz o roteamento entre comandos CLI e TUI.
- `runTui()` chama `render(React.createElement(App, options))` e aguarda
  `waitUntilExit()`.
- `App.tsx` é uma máquina de telas com `screen`:
  `templates`, `run-setup`, `monitor`, `runs`, `task-log`.
- O estado principal fica em hooks pequenos:
  `useStore`, `useRunDraft`, `useRunExecution`, `useRunFilters`,
  `useTaskFilters`, `useInputMode`.
- `useInputMode.ts` modela overlays de entrada como união discriminada:
  `none`, `single`, `multi`.
- `InputOverlay.tsx` implementa entrada single-line e multi-line com atalhos:
  `Enter`, `Esc`, `Ctrl+S`, `Ctrl+L`.
- A TUI tem navegação estilo Vim (`j/k`) e setas.
- A TUI permite filtros de status, provider, busca textual, histórico e
  abertura de logs.
- Os comandos headless usam os mesmos serviços internos da TUI.
- A opção `--output-format` suporta `interactive`, `table`, `json`, `csv`.
- `--query` exige output não interativo, evitando misturar filtro programático
  com TUI quando a semântica seria ambígua.
- Usa `filtrex` para filtros em comandos headless.
- Persiste estado em uma árvore local (`~/.foreach-agent`) com `run.json`,
  prompts, transcripts e exports.

Ideias para reaproveitar na **prosa**:

- Separar núcleo/serviços da TUI. A TUI não deve conter lógica de consulta ou
  exportação; ela deve chamar serviços compartilhados com CLI e MCP.
- Ter uma TUI multi-tela:
  - `sessions`
  - `session-detail`
  - `search`
  - `tool-calls`
  - `artifacts`
  - `exports`
  - `settings/index-status`
- Usar overlays de entrada para busca, filtros, paths de exportação e queries
  avançadas.
- Ter atalhos consistentes:
  - `j/k` ou setas para navegar;
  - `Enter` para abrir;
  - `Esc` para voltar/fechar modal;
  - `/` para busca textual;
  - `?` para ajuda;
  - `x` para export;
  - `R` para reindex/reload.
- Manter os comandos CLI equivalentes para tudo que existir na TUI.

### Referência: mzi-tfplan-explorer

O `mzi-tfplan-explorer` é uma boa referência para uma TUI de exploração de
dados com lista/detalhe, filtros combináveis, query avançada e saídas
programáticas.

Arquivos importantes:

```text
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/README.md
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/main.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/cli.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/output.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/query.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/contract.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/App.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/use-app-input.ts
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/ListView.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/DetailView.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/FilterBar.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/HelpBar.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/ModalLayout.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/AdvancedQueryModal.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/QueryManualModal.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/ExportModal.tsx
/Users/upsetbit/Projects/MZ/mz-iac/tool/src/cmd/mzi-tfplan-explorer/components/visible-window.ts
```

Pontos relevantes observados:

- Usa `ink` e `react` para a TUI.
- O padrão de saída é `interactive`.
- `--output-format` aceita `interactive`, `table`, `json`, `csv`.
- `main.ts` parseia dados, aplica `--query`, e só renderiza a TUI quando o
  output é `interactive`.
- `main.ts` chama `console.clear()` antes de renderizar para remover ruído do
  terminal.
- `App.tsx` calcula altura disponível com `useStdout()` e define
  `visibleHeight`.
- A UI principal é `FilterBar` + `ListView` + `DetailView` + `HelpBar`.
- Modais usam `ModalLayout`.
- `use-app-input.ts` concentra toda a máquina de input e modos:
  `normal`, `layer`, `environment`, `summary`, `search`, `exactAdd`,
  `exactChange`, `exactDestroy`, `export`, `advancedQuery`, `queryManual`.
- A TUI tem lista e detalhe:
  - `list`: navegação e filtros;
  - `detail`: leitura com scroll.
- Tem navegação estilo Vim:
  `j/k`, `gg`, `G`, `Ctrl+D`, `Ctrl+U`, `H`, `M`, `L`.
- Tem busca simples com `/`.
- Tem advanced search com `A`, query multi-line, `Ctrl+S` para aplicar,
  `Ctrl+L` para limpar e `?` para manual.
- `query.ts` normaliza query multi-line e usa `filtrex`.
- `output.ts` serializa o mesmo dataset para `table`, `json` e `csv`.
- A README documenta bem os atalhos e a sintaxe de query.

Ideias para reaproveitar na **prosa**:

- TUI orientada a explorer: lista de sessões à esquerda/centro e detalhe da
  sessão/evento ao abrir.
- Filtros visíveis no topo, como `FilterBar`.
- Help contextual com `?`.
- Manual de query dentro da própria TUI.
- Query avançada multi-line para buscas complexas sobre o formato **W**.
- Modo de detalhe com scroll e atalhos `gg`, `G`, `Ctrl+D`, `Ctrl+U`.
- `visible-window` para listas grandes, evitando renderizar milhares de linhas.
- Mesma semântica de `--output-format` para CLI:
  `interactive`, `table`, `json`, `csv`, e futuramente `markdown`.

### Direção para a TUI da prosa

Com base nesses dois exemplos, a TUI da **prosa** deve começar como um explorer
de dados, não como dashboard complexo.

Comando:

```bash
prosa tui
```

ou, por padrão em alguns subcomandos:

```bash
prosa sessions --output-format interactive
prosa search "erro terraform" --output-format interactive
```

Telas iniciais:

```text
sessions        lista todas as sessões importadas
search          resultados de busca full-text
session-detail  timeline de uma sessão
message-detail  conteúdo completo de uma mensagem/evento
tool-calls      chamadas de ferramenta filtráveis
artifacts       artifacts grandes e referências
exports         fluxo de exportação Markdown/JSON/CSV
```

Atalhos propostos:

```text
j/k, setas      navegar
Enter           abrir item
Esc             voltar/fechar modal
q               sair
/               busca textual
A               advanced query
?               ajuda/manual
f               filtros
s               ciclo de source_tool
m               ciclo de modelo
p               filtro por projeto/path
t               filtro por tool
e               mostrar erros
x               exportar seleção/sessão
R               recarregar/reindexar
gg/G            topo/fim
Ctrl+U/D        meia página
```

Princípio importante: a TUI deve consumir a mesma API interna usada pela CLI e
pelo MCP server. Ela não deve ter caminho de consulta próprio.

## MCP server via HTTP streamable

O MCP server da **prosa** deve usar HTTP streamable, inspirado diretamente na
implementação do Sourcebot em:

```text
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0
```

Arquivos importantes do Sourcebot para referência:

```text
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/src/app/api/(server)/mcp/route.ts
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/src/features/mcp/server.ts
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/src/features/tools/adapters.ts
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/src/features/tools/
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/docs/docs/features/mcp-server.mdx
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/next.config.mjs
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/packages/web/package.json
/Users/upsetbit/Projects/sourcebot/sourcebot-4.17.0/AGENTS.md
```

Pontos relevantes observados:

- A rota HTTP streamable fica em `/api/mcp`.
- A implementação atual do MCP está no pacote web, não no pacote antigo
  `packages/mcp`.
- O próprio `AGENTS.md` do Sourcebot registra que `packages/mcp` está
  depreciado e que a funcionalidade MCP atual vive em
  `packages/web/src/features/mcp/`.
- `route.ts` usa `WebStandardStreamableHTTPServerTransport` de
  `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.
- `route.ts` usa `McpServer` de `@modelcontextprotocol/sdk/server/mcp.js`.
- `POST /api/mcp` cria ou reutiliza uma sessão MCP com base no header
  `MCP-Session-Id`.
- A sessão é armazenada em um `Map` em nível de módulo, adequada para
  single-process/local-first.
- O transporte usa `sessionIdGenerator: () => crypto.randomUUID()`.
- `onsessioninitialized` grava `{ server, transport, ownerId }` no mapa de
  sessões.
- `onsessionclosed` fecha `server` e `transport`, depois remove a sessão.
- `DELETE /api/mcp` encerra/manipula a sessão existente via o mesmo transporte.
- `GET /api/mcp` retorna `405 Method Not Allowed` quando o servidor não oferece
  stream SSE iniciado por servidor. O comentário do Sourcebot registra que isso
  segue a spec do MCP Streamable HTTP.
- O Sourcebot adiciona `Allow: POST, DELETE` no `GET 405`.
- `server.ts` centraliza a criação do `McpServer` e o registro das ferramentas.
- `adapters.ts` mostra um padrão útil: uma definição de ferramenta interna é
  adaptada tanto para MCP quanto para outras superfícies.
- As ferramentas MCP registram `annotations`, incluindo `readOnlyHint` e
  `idempotentHint`.
- `docs/docs/features/mcp-server.mdx` documenta clientes reais usando transporte
  HTTP: Claude Code, Cursor, VS Code, Codex, OpenCode e Windsurf.
- `next.config.mjs` mostra detalhes úteis de OAuth discovery para MCP remoto:
  rewrites para `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource/:path*` e fallback `/register`.

Para a **prosa**, a primeira versão pode reaproveitar o mesmo desenho conceitual:

```text
prosa mcp serve
  -> expõe /api/mcp
  -> aceita POST e DELETE
  -> rejeita GET com 405 se não houver stream SSE server-initiated
  -> gerencia MCP-Session-Id
  -> cria McpServer por sessão
  -> registra tools de consulta sobre W
```

Ferramentas MCP iniciais da **prosa**:

- `search_sessions`: busca full-text em mensagens, tool outputs e summaries.
- `list_sessions`: lista sessões com filtros por data, origem, projeto, modelo
  e branch.
- `get_session`: retorna metadados e timeline resumida de uma sessão.
- `export_session_markdown`: exporta uma sessão para Markdown.
- `list_tool_calls`: filtra chamadas de ferramenta por nome, status, path ou
  sessão.
- `get_artifact`: retorna ou referencia artifacts grandes.
- `find_touched_files`: lista sessões/eventos relacionados a um path.

Exemplo de conexão local:

```bash
prosa mcp serve --transport http --host 127.0.0.1 --port 7331
```

Endpoint:

```text
http://127.0.0.1:7331/api/mcp
```

## Requisitos importantes

- Funcionar localmente, sem cloud.
- Ter um núcleo único de domínio e armazenamento, compartilhado por CLI, TUI e
  MCP server.
- Oferecer MCP via HTTP streamable.
- Preservar os dados brutos originais para auditoria e reimportação.
- Ser idempotente: rodar o importador várias vezes não deve duplicar eventos.
- Permitir evolução de schema.
- Permitir reconstrução de índices.
- Ser rápido para busca e filtros.
- Ser robusto a formatos incompletos ou parcialmente opacos.
- Registrar incertezas, especialmente quando a timeline original não puder ser
  reconstruída com confiança.

## Visão resumida

**prosa** é uma aplicação local para transformar históricos fragmentados de
agentes em uma base única e consultável.

```text
A, B, C, D = formatos nativos das ferramentas
W          = formato canônico unificado
K          = consultas, filtros, buscas, exports e auditoria

prosa: A/B/C/D -> W -> K
```

O valor principal é permitir que todo o histórico de trabalho com agentes vire
um acervo local pesquisável, auditável e exportável.
