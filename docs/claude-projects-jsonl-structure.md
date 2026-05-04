# Como ler `~/.claude/projects`

Data da investigação: 2026-05-03

Este documento descreve a estrutura encontrada em:

```text
/Users/upsetbit/.claude/projects
```

Esse diretório guarda sessões locais do Claude Code, incluindo conversas
principais, subagentes, resultados grandes de ferramentas, memória local de
projeto e índices auxiliares.

O objetivo aqui é documentar o formato **como ele está no disco**, sem propor
uma migração ou uma arquitetura nova.

## Resumo

Ao contrário do Cursor Agent, que guardava sessões em bancos SQLite
`store.db`, o Claude Code usa principalmente arquivos JSON Lines (`.jsonl`).

Resumo do diretório analisado:

```text
202M total
40 diretórios de projeto
1.146 arquivos
743 arquivos .jsonl
92 JSONL de sessões principais
651 JSONL de subagentes
60.476 registros JSONL válidos
0 linhas JSON inválidas
```

Janela temporal observada nos registros JSONL:

```text
2026-01-09T19:44:05.730Z até 2026-05-03T21:27:30.997Z
```

Tipos de arquivo encontrados:

```text
743 .jsonl
303 .json
49  .txt
29  .jpg
21  .md
1   arquivo oculto
```

## Estrutura de diretórios

Formato geral:

```text
~/.claude/projects/
  <project-slug>/
    <session-id>.jsonl
    sessions-index.json
    memory/
      *.md
    <session-id>/
      subagents/
        agent-<agent-id>.jsonl
        agent-<agent-id>.meta.json
      tool-results/
        *.txt
        *.json
        pdf-<id>/
          page-NN.jpg
```

Exemplo real de caminhos:

```text
~/.claude/projects/-Users-upsetbit-Projects-movaincentivo/
~/.claude/projects/-Users-upsetbit-Projects-MZ-squad-staff-mzai/
~/.claude/projects/-Users-upsetbit-Projects--me-upsetbit-BRAIN/
```

O diretório `<project-slug>` é derivado do path do projeto, mas não deve ser
tratado como uma transformação reversível perfeita. Caracteres como `/`, `_`,
`.` e espaços podem acabar representados por `-`.

Para descobrir o path real do projeto, use nesta ordem:

1. `sessions-index.json -> entries[].projectPath`
2. `sessions-index.json -> originalPath`
3. campos `cwd` dentro dos arquivos `.jsonl`

Exemplo:

```bash
jq -r '.entries[]?.projectPath // empty' \
  ~/.claude/projects/-Users-upsetbit-Projects-movaincentivo/sessions-index.json |
  sort -u
```

Ou, se não houver `sessions-index.json` útil:

```bash
jq -r 'select(.cwd != null) | .cwd' \
  ~/.claude/projects/<project-slug>/<session-id>.jsonl |
  head -1
```

## Arquivos principais

### Sessão principal

Uma sessão principal fica diretamente dentro do diretório do projeto:

```text
~/.claude/projects/<project-slug>/<session-id>.jsonl
```

Exemplo:

```text
~/.claude/projects/-Users-upsetbit-Projects-movaincentivo/f07026de-51d3-4547-9eb1-09332a3b1a38.jsonl
```

O nome do arquivo é o `sessionId`.

### Subagente

Subagentes ficam dentro de um diretório com o mesmo nome da sessão principal:

```text
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
```

Exemplo:

```text
~/.claude/projects/<project-slug>/<session-id>/subagents/agent-a54a24a7c3464205a.jsonl
```

O subagente usa o mesmo `sessionId` da sessão principal, mas tem:

```text
isSidechain: true
agentId: <agent-id>
```

### Resultado grande de ferramenta

Quando uma ferramenta gera saída grande demais, o Claude Code salva o conteúdo
fora do JSONL:

```text
~/.claude/projects/<project-slug>/<session-id>/tool-results/<file>
```

Tipos observados:

```text
49 .txt
29 .jpg
2  .json
```

Tamanho total dos `tool-results`:

```text
28M
```

O JSONL normalmente contém uma mensagem com preview e um caminho como:

```text
Full output saved to: /Users/upsetbit/.claude/projects/.../tool-results/...
```

Para busca completa, esses arquivos externos também precisam ser consultados.

## `sessions-index.json`

Alguns diretórios de projeto possuem:

```text
sessions-index.json
```

Foram encontrados:

```text
14 arquivos sessions-index.json
85 entradas de sessão
```

Existem mais sessões principais do que entradas no índice:

```text
92 sessões principais
85 entradas em sessions-index.json
```

Então `sessions-index.json` é um cache/índice auxiliar útil, mas não cobre tudo.
Para varrer todas as sessões, procure diretamente por `*.jsonl`.

Formato observado:

```json
{
  "version": 1,
  "originalPath": "/Users/upsetbit/Projects/MZ/playground2",
  "entries": []
}
```

Quando há sessões:

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "ea68620e-81ad-4caf-8a09-04a8e4f30a46",
      "fullPath": "/Users/upsetbit/.claude/projects/.../ea68620e-81ad-4caf-8a09-04a8e4f30a46.jsonl",
      "fileMtime": 1769050266494,
      "firstPrompt": "Primeira pergunta...",
      "summary": "Resumo da sessão",
      "messageCount": 50,
      "created": "2026-01-07T14:25:17.548Z",
      "modified": "2026-01-07T15:36:15.278Z",
      "gitBranch": "next-mzsites",
      "projectPath": "/Users/upsetbit/Projects/MZ/squad-staff/mzai",
      "isSidechain": false
    }
  ]
}
```

Campos encontrados em `entries[]`:

```text
sessionId
projectPath
modified
messageCount
isSidechain
gitBranch
fullPath
firstPrompt
fileMtime
created
summary
```

Todos os `entries[]` observados tinham:

```text
isSidechain: false
```

Ou seja, o índice cobre sessões principais, não subagentes.

Listar sessões indexadas:

```bash
find ~/.claude/projects -maxdepth 2 -type f -name 'sessions-index.json' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    .entries[]? |
    [$file, .sessionId, .created, .modified, .messageCount, .summary] |
    @tsv
  ' "$f"
done
```

Listar índices e quantas sessões têm:

```bash
find ~/.claude/projects -maxdepth 2 -type f -name 'sessions-index.json' -print |
while read -r f; do
  dir="$(basename "$(dirname "$f")")"
  jq -r --arg dir "$dir" '[$dir, .originalPath, (.entries|length)] | @tsv' "$f"
done |
sort
```

## JSONL das sessões

Cada `.jsonl` é um arquivo JSON Lines:

```text
1 linha = 1 evento JSON
```

Todos os registros analisados eram JSON válido.

Validar todos os JSONL:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -c . "$f" >/dev/null || echo "invalid: $f"
done
```

Contar linhas:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
  xargs -0 wc -l |
  tail -1
```

Ler as primeiras linhas de uma sessão:

```bash
head -5 ~/.claude/projects/<project-slug>/<session-id>.jsonl | jq .
```

Ver somente as chaves de cada linha:

```bash
head -5 ~/.claude/projects/<project-slug>/<session-id>.jsonl |
  jq -c 'keys'
```

## Tipos de evento

Campo principal:

```text
type
```

Tipos encontrados:

```text
28241 assistant
21095 user
7380  progress
958   file-history-snapshot
663   attachment
598   system
408   permission-mode
335   last-prompt
306   queue-operation
236   agent-name
236   custom-title
20    pr-link
```

Contar tipos:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r '.type' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Campos de topo mais comuns

Campos observados e suas frequências:

```text
60476 type
59518 sessionId
58303 timestamp
57977 cwd
57977 gitBranch
57977 isSidechain
57977 parentUuid
57977 userType
57977 uuid
57977 version
55652 slug
49336 message
44316 agentId
27809 requestId
27028 entrypoint
19647 sourceToolAssistantUUID
12061 promptId
7577  toolUseID
7380  data
7380  parentToolUseID
7033  toolUseResult
958   isSnapshotUpdate
958   messageId
958   snapshot
834   permissionMode
663   attachment
598   subtype
496   isMeta
374   level
335   lastPrompt
307   content
306   operation
236   agentName
236   customTitle
201   durationMs
197   hasOutput
197   hookCount
197   hookErrors
197   hookInfos
197   preventedContinuation
197   stopReason
194   messageCount
93    origin
57    error
46    maxRetries
46    retryAttempt
46    retryInMs
43    cause
20    prNumber
20    prRepository
20    prUrl
18    isApiErrorMessage
11    compactMetadata
11    isCompactSummary
11    isVisibleInTranscriptOnly
11    logicalParentUuid
```

Comando para recalcular:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r 'keys[]' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Eventos `user`

Eventos de usuário têm:

```json
{
  "parentUuid": null,
  "isSidechain": false,
  "promptId": "...",
  "type": "user",
  "message": {
    "role": "user",
    "content": "..."
  },
  "uuid": "...",
  "timestamp": "...",
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "...",
  "sessionId": "...",
  "version": "...",
  "gitBranch": "..."
}
```

`message.content` pode ser:

```text
string
array
```

Quando é array, pode incluir resultados de ferramenta:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": "...",
  "is_error": false
}
```

Listar prompts de usuário em sessões principais:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*' -print0 |
while IFS= read -r -d '' f; do
  jq -r '
    select(.type=="user" and (.message.content|type)=="string") |
    [.timestamp, .sessionId, .cwd, .message.content] |
    @tsv
  ' "$f"
done
```

## Eventos `assistant`

Eventos do assistente têm:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "..."
      }
    ],
    "stop_reason": "...",
    "usage": {}
  },
  "requestId": "...",
  "uuid": "...",
  "timestamp": "...",
  "sessionId": "..."
}
```

Modelos encontrados:

```text
16200 claude-haiku-4-5-20251001
8676  claude-opus-4-6
1733  claude-opus-4-7
741   claude-sonnet-4-6
434   claude-opus-4-5-20251101
313   glm-4.5-air
101   glm-4.7
25    claude-sonnet-4-5-20250929
18    <synthetic>
```

Contar modelos:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r 'select(.message.model != null) | .message.model' "$f"
done |
sort |
uniq -c |
sort -nr
```

Extrair texto do assistente:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r '
    select(.type=="assistant") |
    .message.content[]? |
    select(.type=="text") |
    .text
  ' "$f"
done
```

## Blocos de conteúdo

Nos registros `message.content`, foram encontrados:

```text
19647 tool_result
19647 tool_use
7605  text
1042  thinking
31    image
```

Comando:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r '
    select(.message.content|type=="array") |
    .message.content[]? |
    .type // empty
  ' "$f"
done |
sort |
uniq -c |
sort -nr
```

### `text`

Bloco de texto normal:

```json
{
  "type": "text",
  "text": "..."
}
```

### `thinking`

Bloco de raciocínio:

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..."
}
```

### `tool_use`

Chamada de ferramenta feita pelo assistente:

```json
{
  "type": "tool_use",
  "id": "toolu_...",
  "name": "Bash",
  "input": {
    "command": "..."
  }
}
```

Ferramentas mais frequentes:

```text
8644 Read
6307 Bash
1115 Grep
1019 Edit
911  Glob
280  TaskUpdate
276  Write
214  WebSearch
179  WebFetch
170  Agent
145  TaskCreate
111  ToolSearch
46   ExitPlanMode
42   mcp__playwright__browser_take_screenshot
31   mcp__playwright__browser_snapshot
28   mcp__playwright__browser_navigate
20   mcp__playwright__browser_click
13   mcp__playwright__browser_evaluate
10   Monitor
```

Listar chamadas de ferramenta:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_use") |
    [$file, .id, .name, (.input|tostring)] |
    @tsv
  ' "$f"
done
```

### `tool_result`

Resultado de ferramenta, normalmente em evento `user`:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": "...",
  "is_error": false
}
```

Estatísticas:

```text
19065 tool_result_ids únicos
19652 tool_result total
19013 is_error=false
639   is_error=true
```

Listar resultados de ferramenta:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_result") |
    [$file, .tool_use_id, (.is_error // false), (.content|tostring|length)] |
    @tsv
  ' "$f"
done
```

## Relacionar `tool_use` com `tool_result`

A ligação é feita por:

```text
tool_use.id == tool_result.tool_use_id
```

Exemplo:

```json
{
  "type": "tool_use",
  "id": "toolu_01ABC",
  "name": "Bash",
  "input": {
    "command": "ls -la"
  }
}
```

Depois:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01ABC",
  "content": "...",
  "is_error": false
}
```

Consultar chamada e resultado por ID:

```bash
tool_id="toolu_..."

rg -n "\"$tool_id\"" ~/.claude/projects -g '*.jsonl'
```

## Campo `toolUseResult`

Além do bloco `tool_result`, alguns eventos têm um campo de topo:

```text
toolUseResult
```

Foram encontrados:

```text
7043 registros com toolUseResult
6241 object
648  string
154  array
```

Quando é objeto, alguns formatos observados:

### Resultado de Bash

```json
{
  "stdout": "...",
  "stderr": "...",
  "interrupted": false,
  "isImage": false
}
```

### Arquivo lido

```json
{
  "type": "text",
  "file": {
    "filePath": "...",
    "content": "...",
    "numLines": 50,
    "startLine": 1,
    "totalLines": 183
  }
}
```

### Edição

Campos comuns em resultados de edição:

```text
filePath
originalFile
structuredPatch
userModified
oldString
newString
replaceAll
```

### Agente

Campos comuns em resultado de agente/subagente:

```text
agentId
agentType
status
prompt
durationMs
totalDurationMs
totalTokens
totalToolUseCount
usage
```

Listar shapes de `toolUseResult`:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r '
    select(has("toolUseResult")) |
    if (.toolUseResult|type) == "object" then
      "object"
    elif (.toolUseResult|type) == "array" then
      "array"
    else
      (.toolUseResult|type)
    end
  ' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Eventos `progress`

Eventos `progress` acompanham andamento de ferramentas e agentes.

Contagem por `data.type`:

```text
5751 hook_progress
800  agent_progress
609  bash_progress
110  query_update
110  search_results_received
```

Exemplo estrutural:

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "...",
    "hookName": "...",
    "command": "..."
  },
  "parentToolUseID": "toolu_...",
  "toolUseID": "toolu_...",
  "sessionId": "...",
  "timestamp": "..."
}
```

Contar tipos de progresso:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r 'select(.type=="progress") | .data.type // empty' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Eventos `system`

No Claude Code, `type: "system"` aqui não significa necessariamente “system
prompt”. Nos arquivos analisados, esses eventos eram registros operacionais.

Subtipos encontrados:

```text
201 turn_duration
197 stop_hook_summary
115 local_command
46  api_error
17  scheduled_task_fire
11  compact_boundary
6   bridge_status
5   informational
```

Exemplo estrutural:

```json
{
  "type": "system",
  "subtype": "stop_hook_summary",
  "hookCount": 1,
  "hookInfos": [],
  "hookErrors": [],
  "preventedContinuation": false,
  "stopReason": "",
  "hasOutput": false,
  "level": "info",
  "timestamp": "...",
  "uuid": "...",
  "toolUseID": "...",
  "sessionId": "..."
}
```

Contar subtipos:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r 'select(.type=="system") | .subtype // empty' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Eventos `attachment`

Tipos de attachment encontrados:

```text
285 task_reminder
76  deferred_tools_delta
45  skill_listing
45  nested_memory
36  file
33  queued_command
31  hook_success
23  plan_mode_exit
17  plan_mode
16  mcp_instructions_delta
10  directory
7   auto_mode_exit
7   compact_file_reference
6   command_permissions
6   hook_additional_context
6   auto_mode
4   edited_text_file
4   plan_file_reference
2   plan_mode_reentry
2   date_change
2   todo_reminder
1   already_read_file
```

Exemplo:

```json
{
  "type": "attachment",
  "attachment": {
    "type": "file",
    "fileName": "...",
    "content": "..."
  },
  "sessionId": "...",
  "timestamp": "..."
}
```

Contar:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r 'select(.type=="attachment") | .attachment.type // empty' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Outros tipos de evento

### `permission-mode`

Registra modo de permissão da sessão.

Valores:

```text
361 bypassPermissions
29  plan
15  auto
3   acceptEdits
```

Formato:

```json
{
  "type": "permission-mode",
  "permissionMode": "bypassPermissions",
  "sessionId": "..."
}
```

### `last-prompt`

Guarda o último prompt:

```json
{
  "type": "last-prompt",
  "lastPrompt": "...",
  "sessionId": "..."
}
```

### `queue-operation`

Operações de fila:

```text
153 enqueue
118 dequeue
35  remove
```

Formato:

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "...",
  "sessionId": "...",
  "content": "..."
}
```

### `agent-name` e `custom-title`

Metadados de título/nome:

```json
{
  "type": "agent-name",
  "agentName": "...",
  "sessionId": "..."
}
```

```json
{
  "type": "custom-title",
  "customTitle": "...",
  "sessionId": "..."
}
```

### `pr-link`

Associação com pull request:

```json
{
  "type": "pr-link",
  "sessionId": "...",
  "prNumber": 149,
  "prUrl": "...",
  "prRepository": "...",
  "timestamp": "..."
}
```

### `file-history-snapshot`

Snapshots de histórico de arquivo:

```json
{
  "type": "file-history-snapshot",
  "messageId": "...",
  "snapshot": {
    "messageId": "...",
    "trackedFileBackups": {},
    "timestamp": "..."
  },
  "isSnapshotUpdate": false
}
```

Foram encontrados `958` registros desse tipo.

## Subagentes

Foram encontrados:

```text
651 JSONL de subagentes
287 arquivos agent-*.meta.json
```

Subagente:

```text
<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
```

Metadado:

```text
<project-slug>/<session-id>/subagents/agent-<agent-id>.meta.json
```

Campos em `meta.json`:

```text
agentType
description
```

Tipos mais comuns em `agentType`:

```text
Explore
Plan
general-purpose
plane-operator
```

Contar tipos:

```bash
find ~/.claude/projects -type f -path '*/subagents/*.meta.json' -print0 |
while IFS= read -r -d '' f; do
  jq -r '.agentType // empty' "$f"
done |
sort |
uniq -c |
sort -nr
```

Um subagente normalmente tem:

```text
sessionId: mesmo ID da sessão principal
agentId: ID do subagente
isSidechain: true
slug: slug humano/aleatório da sessão
sourceToolAssistantUUID: UUID do evento assistente que originou a ação
```

Listar subagentes:

```bash
find ~/.claude/projects -type f -path '*/subagents/*.jsonl' -print |
while read -r f; do
  jq -r --arg file "$f" '
    select(.agentId != null) |
    [$file, .sessionId, .agentId, .slug, .cwd] |
    @tsv
  ' "$f" |
  head -1
done
```

## Relação entre sessão principal e subagentes

Uma chamada de subagente aparece na sessão principal como ferramenta `Agent`:

```json
{
  "type": "tool_use",
  "id": "toolu_...",
  "name": "Agent",
  "input": {
    "subagent_type": "Explore",
    "description": "...",
    "prompt": "..."
  }
}
```

O JSONL do subagente fica em:

```text
<project-slug>/<session-id>/subagents/agent-<agent-id>.jsonl
```

Dentro dos registros do subagente, `sourceToolAssistantUUID` aponta para o
`uuid` de eventos do assistente associados à origem daquele fluxo.

Listar chamadas `Agent`:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_use" and .name=="Agent") |
    [
      $file,
      .id,
      (.input.subagent_type // .input.agent_type // ""),
      (.input.description // ""),
      (.input.prompt // "" | length)
    ] |
    @tsv
  ' "$f"
done
```

## Artefatos em `tool-results`

Foram encontrados:

```text
80 arquivos em tool-results
28M total
49 .txt
29 .jpg
2  .json
```

Os maiores arquivos observados incluem:

```text
14.6M bd460tb4b.txt
1.3M  bkc5jvd0v.txt
755K  mcp-playwright-browser_snapshot-*.txt
545K  bqjoipuc2.txt
```

Listar artefatos:

```bash
find ~/.claude/projects -type f -path '*/tool-results/*' -print |
while read -r f; do
  rel="${f#/Users/upsetbit/.claude/projects/}"
  bytes="$(wc -c < "$f" | tr -d ' ')"
  printf '%s\t%s\n' "$bytes" "$rel"
done |
sort -nr |
head -50
```

Buscar texto em artefatos:

```bash
rg -n "termo" ~/.claude/projects -g '*.txt' -g '*.json' -g '*.md'
```

Imagens extraídas de PDF aparecem como:

```text
tool-results/pdf-<uuid>/page-01.jpg
tool-results/pdf-<uuid>/page-02.jpg
...
```

## Diretório `memory`

Alguns projetos têm:

```text
memory/
```

Com arquivos Markdown, por exemplo:

```text
memory/MEMORY.md
memory/feedback_verify_before_claiming.md
memory/feedback_lei_15211.md
```

Esses arquivos fazem parte do estado/memória local daquele projeto no Claude
Code.

Listar memórias:

```bash
find ~/.claude/projects -path '*/memory/*' -type f -print
```

Buscar nelas:

```bash
rg -n "termo" ~/.claude/projects -g '*.md'
```

## Consultas úteis

### Buscar texto em tudo que é textual

```bash
rg -n "termo" ~/.claude/projects \
  -g '*.jsonl' \
  -g '*.json' \
  -g '*.txt' \
  -g '*.md'
```

### Buscar somente em sessões principais

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*' -print0 |
xargs -0 rg -n "termo"
```

### Buscar somente em subagentes

```bash
find ~/.claude/projects -type f -path '*/subagents/*.jsonl' -print0 |
xargs -0 rg -n "termo"
```

### Buscar por `sessionId`

```bash
session="..."
rg -n "\"sessionId\":\"$session\"" ~/.claude/projects -g '*.jsonl'
```

### Buscar por `uuid`

```bash
uuid="..."
rg -n "\"uuid\":\"$uuid\"" ~/.claude/projects -g '*.jsonl'
```

### Buscar por ferramenta

```bash
tool="Bash"

find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" --arg tool "$tool" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_use" and .name==$tool) |
    [$file, .id, .name, (.input|tostring)] |
    @tsv
  ' "$f"
done
```

### Buscar comandos Bash executados

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_use" and .name=="Bash") |
    [$file, .id, (.input.command // "")] |
    @tsv
  ' "$f"
done
```

### Buscar arquivos lidos por `Read`

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_use" and .name=="Read") |
    [$file, .id, (.input.file_path // .input.path // "")] |
    @tsv
  ' "$f"
done
```

### Buscar resultados com erro

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.message.content|type=="array") |
    .message.content[]? |
    select(.type=="tool_result" and (.is_error == true)) |
    [$file, .tool_use_id, (.content|tostring|.[0:300])] |
    @tsv
  ' "$f"
done
```

### Extrair timeline de uma sessão

```bash
file="$HOME/.claude/projects/<project-slug>/<session-id>.jsonl"

jq -r '
  [
    .timestamp,
    .type,
    (.message.role // ""),
    (.message.model // ""),
    (.uuid // ""),
    (.parentUuid // "")
  ] |
  @tsv
' "$file"
```

### Extrair texto legível de uma sessão

```bash
file="$HOME/.claude/projects/<project-slug>/<session-id>.jsonl"

jq -r '
  if .type == "user" then
    if (.message.content|type) == "string" then
      "USER:\n" + .message.content + "\n"
    else
      empty
    end
  elif .type == "assistant" then
    (
      .message.content[]? |
      select(.type=="text") |
      "ASSISTANT:\n" + .text + "\n"
    )
  else
    empty
  end
' "$file"
```

### Extrair todos os textos de assistente

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.type=="assistant") |
    .message.content[]? |
    select(.type=="text") |
    [$file, .text] |
    @tsv
  ' "$f"
done
```

### Extrair todos os prompts de usuário

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.type=="user") |
    if (.message.content|type) == "string" then
      [$file, .timestamp, .sessionId, .message.content] | @tsv
    else
      empty
    end
  ' "$f"
done
```

## Agrupar por projeto

Listar projetos por tamanho e quantidade de sessões:

```bash
for d in ~/.claude/projects/*; do
  [ -d "$d" ] || continue
  main="$(find "$d" -maxdepth 1 -type f -name '*.jsonl' | wc -l | tr -d ' ')"
  sub="$(find "$d" -type f -path '*/subagents/*.jsonl' | wc -l | tr -d ' ')"
  tr="$(find "$d" -type f -path '*/tool-results/*' | wc -l | tr -d ' ')"
  size="$(du -sh "$d" | awk '{print $1}')"
  printf '%s\t%s\t%s\t%s\t%s\n' "$size" "$main" "$sub" "$tr" "$(basename "$d")"
done |
sort -hr
```

Maiores diretórios observados:

```text
59M  -Users-upsetbit-Projects-MZ-squad-staff-mzai
39M  -Users-upsetbit-Projects-movaincentivo
24M  -Users-upsetbit-Projects-mestry
19M  -Users-upsetbit-Projects-sourcebot-sourcebot-4-17-0
13M  -Users-upsetbit-Projects-iava
9.7M -Users-upsetbit-Projects-MZ-sites
8.5M -Users-upsetbit-Projects-MZ-mz-operator-1
6.3M -Users-upsetbit-Projects-MZ-mz-iac
6.0M -Users-upsetbit-Projects-MZ-squad-staff-wp-replacement
```

## Campos de navegação

Para reconstruir a conversa em ordem:

- use a ordem das linhas do JSONL;
- ou ordene por `timestamp`;
- `uuid` identifica o evento;
- `parentUuid` aponta para o evento anterior/pai;
- `sessionId` agrupa tudo na sessão;
- `isSidechain` separa sessão principal de subagentes;
- `agentId` identifica subagente quando existe;
- `sourceToolAssistantUUID` ajuda a ligar resultados laterais à mensagem do
  assistente que originou a ação.

Exemplo de timeline:

```bash
jq -r '
  [
    .timestamp,
    .type,
    (.uuid // ""),
    (.parentUuid // ""),
    (.agentId // ""),
    (.sourceToolAssistantUUID // "")
  ] |
  @tsv
' ~/.claude/projects/<project-slug>/<session-id>.jsonl
```

## Modos e versões

### `entrypoint`

Valores encontrados:

```text
26828 cli
200   sdk-cli
33448 ausente
```

### `userType`

Valores:

```text
57977 external
2499  ausente
```

### `isSidechain`

Valores:

```text
44316 true
13661 false
2499  ausente
```

Muitos eventos são de subagentes (`isSidechain: true`), porque há bem mais
JSONL de subagentes do que sessões principais.

### `version`

Versões mais frequentes:

```text
6026 2.1.92
4851 2.1.98
4498 2.1.34
4460 2.1.104
2868 2.1.76
2792 2.1.63
2484 2.1.112
2205 2.1.72
2057 2.1.69
2029 2.1.77
```

Contar versões:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r '.version // empty' "$f"
done |
sort |
uniq -c |
sort -nr
```

## Observações importantes

1. `sessions-index.json` é incompleto.

   Use-o como índice auxiliar, não como fonte total. Para varrer tudo, use
   `find ~/.claude/projects -type f -name '*.jsonl'`.

2. `type: "system"` não equivale a `message.role: "system"`.

   Nos dados analisados, `system` é tipo de evento operacional do Claude Code:
   hooks, duração de turno, comandos locais, erros de API etc.

3. Resultados grandes podem estar fora do JSONL.

   Procure em `tool-results/`. O JSONL pode conter apenas preview e caminho.

4. Subagentes são maioria.

   Há `651` JSONL de subagentes contra `92` sessões principais. Se a consulta
   deve cobrir toda a atividade, inclua `*/subagents/*.jsonl`.

5. O campo `toolUseResult` pode duplicar ou estruturar melhor o conteúdo que
   aparece como `tool_result`.

   Para buscas simples, `message.content[].content` costuma ser suficiente. Para
   reconstrução mais fiel, leia também `toolUseResult`.

6. Nem todo conteúdo textual está em `message.content`.

   Attachments, tool results persistidos, memory files e snapshots também podem
   ter conteúdo relevante.

## Consulta rápida por tipo de dado

Conversas principais:

```bash
find ~/.claude/projects -type f -name '*.jsonl' -not -path '*/subagents/*'
```

Subagentes:

```bash
find ~/.claude/projects -type f -path '*/subagents/*.jsonl'
```

Metadados de subagente:

```bash
find ~/.claude/projects -type f -path '*/subagents/*.meta.json'
```

Resultados persistidos:

```bash
find ~/.claude/projects -type f -path '*/tool-results/*'
```

Memória de projeto:

```bash
find ~/.claude/projects -type f -path '*/memory/*'
```

Índices de sessão:

```bash
find ~/.claude/projects -maxdepth 2 -type f -name 'sessions-index.json'
```

## Conclusão

`~/.claude/projects` é um armazenamento local baseado em arquivos, não banco de
dados.

O formato principal é:

```text
um diretório por projeto
um JSONL por sessão principal
um diretório por sessão para artefatos
um JSONL por subagente
arquivos externos para saídas grandes
índices JSON auxiliares em alguns projetos
memória Markdown em alguns projetos
```

Para consultar programaticamente, a base é:

1. varrer todos os `*.jsonl`;
2. ler linha por linha como JSON;
3. usar `type` para separar evento;
4. usar `message.content[]` para texto, tool calls e tool results;
5. usar `sessionId`, `uuid`, `parentUuid`, `agentId` e
   `sourceToolAssistantUUID` para navegação;
6. incluir `tool-results/` quando a busca precisar cobrir outputs grandes;
7. usar `sessions-index.json` apenas como índice auxiliar.

