# Como ler as sessões do Codex CLI

Data da investigação: 2026-05-03

Este documento descreve o processo usado para entender e consultar os arquivos
de sessão do Codex CLI em:

```text
~/.codex/sessions/
```

O objetivo foi descobrir:

- como a árvore de sessões é organizada;
- qual formato os arquivos usam;
- quais tipos de registros aparecem nos JSONL;
- onde ficam metadados, contexto, mensagens e chamadas de ferramenta;
- como listar sessões por data, workspace, modelo e diretório;
- como pesquisar chats sem depender da interface do Codex.

Este documento evita depender do conteúdo específico das conversas. Os comandos
mostram a técnica e os formatos.

## Resumo

Os arquivos encontrados seguem este padrão:

```text
~/.codex/sessions/<ano>/<mes>/<dia>/rollout-<data-local>T<hora-local>-<session-id>.jsonl
```

Exemplo de forma:

```text
~/.codex/sessions/2026/05/03/rollout-2026-05-03T18-27-41-019defbd-6b97-71e0-9a17-ed1a284cae39.jsonl
```

No ambiente analisado havia:

```text
1035 arquivos .jsonl
aprox. 536 mil linhas JSONL
934 MB no total
2025-08-20 como sessão mais antiga
2026-05-03 como sessão mais recente
```

Todos os arquivos `.jsonl` validaram como JSONL parseável com `jq`.
Os contadores podem variar enquanto o Codex está aberto, porque a sessão atual
continua sendo anexada ao arquivo mais recente.

A interpretação prática é:

- Cada arquivo `rollout-*.jsonl` representa uma sessão ou sub-sessão.
- A árvore `YYYY/MM/DD` usa a data local do ambiente.
- O timestamp dentro do JSON costuma ser ISO UTC, por exemplo `2026-05-03T21:27:41Z`.
- O sufixo do nome do arquivo é o `session-id`, que bate com `session_meta.payload.id`
  nos arquivos recentes.
- Arquivos recentes usam envelopes com `type`, `timestamp` e `payload`.
- Arquivos antigos também podem guardar itens diretamente no topo, como `message`,
  `reasoning`, `function_call` e `function_call_output`.

## 1. Descoberta inicial

Contar sessões:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print | wc -l
```

Ver exemplos:

```bash
find ~/.codex/sessions -maxdepth 4 -type f -name '*.jsonl' -print | head -20
```

Ver tamanho total:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 du -ch 2>/dev/null |
  tail -1
```

Contar por ano:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' |
  awk -F/ '{count[$6]++} END {for (y in count) print y, count[y]}' |
  sort
```

No ambiente analisado:

```text
2025 262
2026 773
```

Contar por mês:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' |
  awk -F/ '{printf "%s-%s\n", $6, $7}' |
  sort |
  uniq -c
```

No ambiente analisado:

```text
  17 2025-08
   4 2025-09
  43 2025-10
  65 2025-11
 133 2025-12
 124 2026-01
 178 2026-02
 193 2026-03
 267 2026-04
  11 2026-05
```

Validar JSONL:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq empty "$f" >/dev/null 2>&1 || printf '%s\n' "$f"
done
```

Resultado esperado quando todos validam: nenhuma linha.

## 2. Formato dos arquivos

Os arquivos são JSON Lines: cada linha é um objeto JSON independente.

Ver as primeiras chaves de uma sessão:

```bash
f="$HOME/.codex/sessions/2026/05/03/rollout-2026-05-03T18-27-41-019defbd-6b97-71e0-9a17-ed1a284cae39.jsonl"
head -n 5 "$f" | jq -c 'keys'
```

Em arquivos recentes, o formato típico é:

```json
{
  "timestamp": "2026-05-03T21:27:41.778Z",
  "type": "session_meta",
  "payload": {}
}
```

Tipos top-level observados no conjunto completo:

```text
286146 response_item
206264 event_msg
40063  turn_context
1242   __missing__
1029   session_meta
576    function_call_output
576    function_call
371    reasoning
247    compacted
82     message
```

Notas:

- Os números acima são uma fotografia da investigação; a sessão atual pode
  acrescentar novas linhas enquanto os comandos rodam.
- `response_item`, `event_msg`, `turn_context` e `session_meta` são o formato
  envelopado atual.
- `message`, `reasoning`, `function_call` e `function_call_output` no topo são
  formato legado ou registros gravados sem envelope.
- Registros sem `type` apareceram principalmente como `{"record_type":"state"}`
  em sessões antigas.

Contar tipos no seu ambiente:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'if has("type") then (.type|tostring) else "__missing__" end' |
  sort |
  uniq -c |
  sort -nr
```

## 3. `session_meta`

`session_meta` guarda metadados da sessão.

Inspecionar chaves sem despejar conteúdo:

```bash
jq -c '
  select(.type=="session_meta") |
  {top_keys:(keys|sort), payload_keys:(.payload|keys|sort)}
' "$f"
```

Formato típico de chaves:

```text
top:     payload, timestamp, type
payload: base_instructions, cli_version, cwd, id, model_provider,
         originator, source, timestamp
```

Campos úteis:

- `payload.id`: identificador da sessão.
- `payload.timestamp`: início da sessão em UTC.
- `payload.cwd`: diretório de trabalho inicial.
- `payload.cli_version`: versão do Codex CLI.
- `payload.originator`: origem do cliente, por exemplo CLI ou TUI.
- `payload.source`: origem da sessão; pode ser string ou objeto em sessões com
  sub-agentes.

Extrair metadados de uma sessão:

```bash
jq -c '
  select(.type=="session_meta") |
  {
    id: .payload.id,
    created_utc: .payload.timestamp,
    cli_version: .payload.cli_version,
    cwd: .payload.cwd,
    originator: .payload.originator,
    source_type: (.payload.source|type)
  }
' "$f"
```

Listar todas as sessões com metadados principais:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.type=="session_meta") |
    [
      .payload.timestamp,
      .payload.id,
      (.payload.cli_version // ""),
      (.payload.originator // ""),
      (.payload.cwd // ""),
      $file
    ] | @tsv
  ' "$f"
done |
sort
```

## 4. `turn_context`

`turn_context` aparece por turno e guarda o contexto de execução usado naquela
interação.

Inspecionar chaves:

```bash
jq -c '
  select(.type=="turn_context") |
  {top_keys:(keys|sort), payload_keys:(.payload|keys|sort)}
' "$f" | head
```

Chaves observadas:

```text
approval_policy, collaboration_mode, current_date, cwd, effort, model,
permission_profile, personality, realtime_active, sandbox_policy, summary,
timezone, truncation_policy, turn_id, user_instructions
```

Campos úteis:

- `payload.cwd`: diretório de trabalho do turno.
- `payload.model`: modelo usado naquele turno.
- `payload.effort`: esforço de raciocínio.
- `payload.approval_policy`: política de aprovação.
- `payload.sandbox_policy`: perfil de sandbox.
- `payload.current_date` e `payload.timezone`: data e timezone vistos pelo agente.
- `payload.user_instructions`: instruções de usuário injetadas no contexto.
- `payload.summary`: resumo de contexto quando houve compactação ou retomada.

Listar modelos usados:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'select(.type=="turn_context") | (.payload.model // "__missing__")' |
  sort |
  uniq -c |
  sort -nr
```

Listar diretórios de trabalho mais frequentes, abreviando `$HOME`:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'select(.type=="turn_context") | (.payload.cwd // "__missing__")' |
  sed "s#$HOME#~#" |
  sort |
  uniq -c |
  sort -nr |
  head -30
```

## 5. Mensagens de chat

Há duas fontes práticas para recuperar conversa:

- `response_item` com `payload.type == "message"`: transcript estruturado enviado
  ou recebido pelo modelo.
- `event_msg` com `payload.type == "user_message"` ou `agent_message`: eventos da
  interface, geralmente mais próximos do que apareceu na tela.

Em formato atual, uma mensagem aparece assim:

```json
{
  "type": "response_item",
  "timestamp": "2026-05-03T21:27:41.000Z",
  "payload": {
    "type": "message",
    "role": "user",
    "content": [
      {"type": "input_text", "text": "..."}
    ]
  }
}
```

Em formato legado, a própria linha pode ser a mensagem:

```json
{
  "type": "message",
  "role": "assistant",
  "content": [
    {"type": "output_text", "text": "..."}
  ]
}
```

Contagem de roles em `response_item` no ambiente analisado:

```text
21186 assistant
7005  user
1516  developer
```

Contagem de mensagens legadas no topo:

```text
43 assistant
39 user
```

Extrair mensagens de uma sessão para TSV:

```bash
jq -r '
  def text_content($c):
    if ($c|type) == "array" then
      [$c[]? | .text? // empty] | join("\n")
    elif ($c|type) == "string" then
      $c
    else
      ""
    end;

  if .type=="response_item" and .payload.type=="message" then
    [.timestamp, .payload.role, text_content(.payload.content)] | @tsv
  elif .type=="message" then
    [.timestamp, .role, text_content(.content)] | @tsv
  else
    empty
  end
' "$f"
```

Extrair eventos de tela de uma sessão:

```bash
jq -r '
  select(.type=="event_msg" and
    (.payload.type=="user_message" or .payload.type=="agent_message")) |
  [
    .timestamp,
    (if .payload.type=="user_message" then "user" else "assistant" end),
    (.payload.message // "")
  ] | @tsv
' "$f"
```

## 6. Chamadas de ferramenta e eventos

`response_item` também registra chamadas de ferramenta e saídas:

```text
89852 function_call
89834 function_call_output
61239 reasoning
29707 message
6681  custom_tool_call_output
6681  custom_tool_call
1961  web_search_call
177   ghost_snapshot
17    tool_search_output
17    tool_search_call
```

Contar subtipos de `response_item`:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'select(.type=="response_item") | (.payload.type // "__missing__")' |
  sort |
  uniq -c |
  sort -nr
```

`event_msg` registra eventos operacionais da UI e das ferramentas:

```text
110322 token_count
34349  agent_reasoning
26090  exec_command_end
20945  agent_message
4982   user_message
2995   task_started
2680   task_complete
1582   patch_apply_end
660    web_search_end
594    mcp_tool_call_end
547    turn_aborted
254    item_completed
241    context_compacted
14     view_image_tool_call
8      collab_agent_spawn_end
7      collab_waiting_end
1      error
```

Contar subtipos de `event_msg`:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'select(.type=="event_msg") | (.payload.type // "__missing__")' |
  sort |
  uniq -c |
  sort -nr
```

Listar comandos executados em uma sessão:

```bash
jq -r '
  select(.type=="event_msg" and .payload.type=="exec_command_end") |
  [
    .timestamp,
    (.payload.exit_code // ""),
    (.payload.cwd // ""),
    ((.payload.command // "") | if type=="string" then . else tojson end)
  ] | @tsv
' "$f"
```

Listar chamadas de função registradas no transcript:

```bash
jq -r '
  if .type=="response_item" and .payload.type=="function_call" then
    [
      .timestamp,
      .payload.call_id,
      .payload.name,
      ((.payload.arguments // "") | if type=="string" then . else tojson end)
    ] | @tsv
  elif .type=="function_call" then
    [
      .timestamp,
      .call_id,
      .name,
      ((.arguments // "") | if type=="string" then . else tojson end)
    ] | @tsv
  else
    empty
  end
' "$f"
```

## 7. Pesquisar por texto bruto

Para uma busca rápida em todo o armazenamento, use `rg` diretamente nos JSONL:

```bash
rg -n -i "termo de busca" ~/.codex/sessions
```

Limitar por data:

```bash
rg -n -i "termo de busca" ~/.codex/sessions/2026/04
rg -n -i "termo de busca" ~/.codex/sessions/2026/05/03
```

Buscar nomes de arquivos que contêm o termo:

```bash
rg -l -i "termo de busca" ~/.codex/sessions
```

Observações:

- `rg` é o jeito mais rápido para uma primeira localização.
- A saída mostra linhas JSON inteiras; pode ser verbosa e conter dados sensíveis.
- Depois de encontrar arquivos candidatos com `rg -l`, use `jq` para extrair só
  mensagens, metadados ou eventos relevantes.

## 8. Pesquisar apenas em chats

Este comando pesquisa somente mensagens conversacionais, incluindo formato atual,
formato legado e eventos de tela:

```bash
q="termo de busca"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    def row($role; $text):
      {
        file: input_filename,
        ts: (.timestamp // ""),
        role: $role,
        text: $text
      };

    if .type=="response_item" and .payload.type=="message" then
      row(.payload.role; text_content(.payload.content))
    elif .type=="message" then
      row(.role; text_content(.content))
    elif .type=="event_msg" and
      (.payload.type=="user_message" or .payload.type=="agent_message") then
      row(
        if .payload.type=="user_message" then "user_event" else "assistant_event" end;
        (.payload.message // "")
      )
    else
      empty
    end
    | select(.text | test($q; "i"))
    | [
        .ts,
        .role,
        .file,
        (.text | gsub("\n"; " ") | .[0:240])
      ] | @tsv
  '
```

Pesquisar só mensagens do usuário:

```bash
q="termo de busca"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    if .type=="response_item" and .payload.type=="message" and .payload.role=="user" then
      {file: input_filename, ts: .timestamp, text: text_content(.payload.content)}
    elif .type=="message" and .role=="user" then
      {file: input_filename, ts: (.timestamp // ""), text: text_content(.content)}
    elif .type=="event_msg" and .payload.type=="user_message" then
      {file: input_filename, ts: .timestamp, text: (.payload.message // "")}
    else
      empty
    end
    | select(.text | test($q; "i"))
    | [.ts, .file, (.text | gsub("\n"; " ") | .[0:240])] | @tsv
  '
```

## 9. Listar sessões com primeiro prompt

Para montar um índice navegável das sessões, este comando emite uma linha por
arquivo com data, id, versão, cwd e o primeiro texto de usuário encontrado:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -rs --arg file "$f" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    def chat_message:
      if .type=="response_item" and .payload.type=="message" then
        {role:.payload.role, text:text_content(.payload.content)}
      elif .type=="message" then
        {role:.role, text:text_content(.content)}
      elif .type=="event_msg" and .payload.type=="user_message" then
        {role:"user", text:(.payload.message // "")}
      else
        empty
      end;

    {
      file: $file,
      created_utc: ([.[] | select(.type=="session_meta") | .payload.timestamp][0] // ""),
      id: ([.[] | select(.type=="session_meta") | .payload.id][0] // ""),
      cli_version: ([.[] | select(.type=="session_meta") | .payload.cli_version][0] // ""),
      cwd: (
        [.[] | select(.type=="session_meta") | .payload.cwd][0] //
        [.[] | select(.type=="turn_context") | .payload.cwd][0] //
        ""
      ),
      first_user: ([.[] | chat_message | select(.role=="user") | .text][0] // "")
    }
    | [
        .created_utc,
        .id,
        .cli_version,
        .cwd,
        (.first_user | gsub("\n"; " ") | .[0:180]),
        .file
      ] | @tsv
  ' "$f"
done |
sort
```

Para gerar um arquivo:

```text
~/.codex/analysis/sessions-index.tsv
```

Crie o diretório e redirecione a saída do pipeline anterior:

```bash
mkdir -p ~/.codex/analysis
```

## 10. Filtrar por workspace, modelo ou data

Filtrar sessões por `cwd`:

```bash
needle="/Users/upsetbit/Projects/nome-do-projeto"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -s -e --arg needle "$needle" '
    any(.[];
      (.type=="session_meta" and ((.payload.cwd // "") | contains($needle))) or
      (.type=="turn_context" and ((.payload.cwd // "") | contains($needle)))
    )
  ' "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
done
```

Filtrar por modelo usado em `turn_context`:

```bash
model="gpt-5.4"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -s -e --arg model "$model" '
    any(.[]; .type=="turn_context" and (.payload.model // "") == $model)
  ' "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
done
```

Filtrar por dia:

```bash
find ~/.codex/sessions/2026/05/03 -type f -name '*.jsonl' -print
```

Filtrar por intervalo usando o timestamp do nome do arquivo:

```bash
find ~/.codex/sessions/2026/04 -type f -name '*.jsonl' |
  awk -F/ '
    {
      name=$NF
      if (name >= "rollout-2026-04-10" && name < "rollout-2026-04-20")
        print
    }
  '
```

## 11. Exportar uma conversa para Markdown

Este comando converte uma sessão específica em Markdown simples:

```bash
f="$HOME/.codex/sessions/2026/05/03/rollout-2026-05-03T18-27-41-019defbd-6b97-71e0-9a17-ed1a284cae39.jsonl"
out="/tmp/codex-session.md"

jq -r '
  def text_content($c):
    if ($c|type) == "array" then
      [$c[]? | .text? // empty] | join("\n")
    elif ($c|type) == "string" then
      $c
    else
      ""
    end;

  if .type=="response_item" and .payload.type=="message" then
    {role:.payload.role, text:text_content(.payload.content)}
  elif .type=="message" then
    {role:.role, text:text_content(.content)}
  elif .type=="event_msg" and
    (.payload.type=="user_message" or .payload.type=="agent_message") then
    {
      role:(if .payload.type=="user_message" then "user" else "assistant" end),
      text:(.payload.message // "")
    }
  else
    empty
  end
  | select(.text != "")
  | "## " + (.role | ascii_upcase) + "\n\n" + .text + "\n"
' "$f" > "$out"
```

## 12. Exportar resultados pesquisáveis

Gerar um JSONL normalizado só com mensagens:

```bash
out="$HOME/.codex/analysis/codex-messages.jsonl"
mkdir -p "$(dirname "$out")"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -c '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    if .type=="response_item" and .payload.type=="message" then
      {
        file: input_filename,
        timestamp: .timestamp,
        source: "response_item",
        role: .payload.role,
        text: text_content(.payload.content)
      }
    elif .type=="message" then
      {
        file: input_filename,
        timestamp: (.timestamp // null),
        source: "legacy_message",
        role: .role,
        text: text_content(.content)
      }
    elif .type=="event_msg" and
      (.payload.type=="user_message" or .payload.type=="agent_message") then
      {
        file: input_filename,
        timestamp: .timestamp,
        source: .payload.type,
        role: (if .payload.type=="user_message" then "user" else "assistant" end),
        text: (.payload.message // "")
      }
    else
      empty
    end
    | select(.text != "")
  ' > "$out"
```

Depois pesquise no índice normalizado:

```bash
jq -r --arg q "termo de busca" '
  select(.text | test($q; "i")) |
  [.timestamp, .role, .file, (.text | gsub("\n"; " ") | .[0:240])] | @tsv
' "$HOME/.codex/analysis/codex-messages.jsonl"
```

## 13. Cuidados práticos

- Os JSONL podem conter prompts, código, saídas de comando, caminhos locais,
  variáveis e material sensível. Evite colar linhas brutas inteiras em lugares
  externos.
- `event_msg.exec_command_end` pode conter `stdout`, `stderr`, `formatted_output`
  e `aggregated_output`; esses campos podem ser grandes.
- `response_item.function_call_output.output` também pode conter saídas grandes.
- `reasoning` pode conter `encrypted_content` e `summary`; não assuma que todo
  raciocínio está legível.
- Para pesquisa rápida, use `rg`. Para extração limpa, use `jq`.
- Para auditorias ou backups, trate `~/.codex/sessions` como dado pessoal.

## 14. Receita curta

Encontrar sessões que mencionam um termo:

```bash
rg -l -i "termo" ~/.codex/sessions
```

Pesquisar só mensagens e mostrar contexto curto:

```bash
q="termo"
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
    if .type=="response_item" and .payload.type=="message" then
      {file:input_filename, ts:.timestamp, role:.payload.role, text:t(.payload.content)}
    elif .type=="message" then
      {file:input_filename, ts:(.timestamp // ""), role:.role, text:t(.content)}
    elif .type=="event_msg" and (.payload.type=="user_message" or .payload.type=="agent_message") then
      {file:input_filename, ts:.timestamp, role:.payload.type, text:(.payload.message // "")}
    else empty end
    | select(.text | test($q; "i"))
    | [.ts, .role, .file, (.text | gsub("\n"; " ") | .[0:180])] | @tsv
  '
```

Abrir uma sessão específica como conversa Markdown:

```bash
f="/ABSOLUTE/PATH/rollout-....jsonl"
jq -r '
  def t($c): if ($c|type)=="array" then [$c[]?.text? // empty] | join("\n") else ($c // "") end;
  if .type=="response_item" and .payload.type=="message" then
    {role:.payload.role, text:t(.payload.content)}
  elif .type=="message" then
    {role:.role, text:t(.content)}
  else empty end
  | select(.text != "")
  | "## " + (.role|ascii_upcase) + "\n\n" + .text + "\n"
' "$f"
```

## 15. Diferenças em relação ao layout do Claude Code

O relatório de `~/.claude/projects` precisa cobrir mais tipos de arquivo porque
o Claude Code usa uma árvore por projeto com índices, memória local, subagentes e
artefatos externos de ferramenta.

Em `~/.codex/sessions`, o armazenamento observado é mais concentrado:

```text
1035 arquivos .jsonl
7 arquivos .DS_Store
nenhum sessions-index.json
nenhum diretório tool-results dentro de sessions
nenhum diretório memory dentro de sessions
```

Ou seja:

- O Codex não mantém, dentro de `sessions`, um índice equivalente ao
  `sessions-index.json` do Claude.
- O Codex não separa resultados grandes em uma pasta `tool-results`; saídas de
  comando e ferramentas aparecem dentro de eventos JSONL como
  `event_msg.exec_command_end`, `event_msg.mcp_tool_call_end`,
  `response_item.function_call_output` e `response_item.custom_tool_call_output`.
- Subagentes do Codex não ficam em um subdiretório da sessão pai. Eles aparecem
  como sessões normais na árvore por data, com metadados apontando para a sessão
  pai.

Para inventariar tipos de arquivo:

```bash
find ~/.codex/sessions -type f |
awk '
  {
    n=$0
    sub(/^.*\//, "", n)
    if (n ~ /\./) {
      ext=n
      sub(/^.*\./, "", ext)
      print "." ext
    } else {
      print "__no_ext__"
    }
  }
' |
sort |
uniq -c |
sort -nr
```

No ambiente analisado:

```text
1035 .jsonl
7    .DS_Store
```

## 16. Identidade da sessão

Nos arquivos recentes, a identidade da sessão aparece em dois lugares:

```text
nome do arquivo: rollout-<data>T<hora>-<session-id>.jsonl
JSONL:           session_meta.payload.id
```

Verificar se os IDs batem:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  meta_id="$(
    jq -r 'select(.type=="session_meta") | .payload.id' "$f" 2>/dev/null |
      head -1
  )"

  name_id="$(
    basename "$f" .jsonl |
      sed -E 's/^rollout-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-//'
  )"

  if [ -z "$meta_id" ]; then
    echo missing_meta
  elif [ "$meta_id" = "$name_id" ]; then
    echo match
  else
    echo mismatch
  fi
done |
sort |
uniq -c
```

No ambiente analisado:

```text
1016 match
19   missing_meta
```

Também foram observados:

```text
1029 registros session_meta
1016 arquivos com pelo menos um session_meta
```

Interpretação:

- A maior parte dos arquivos recentes tem `session_meta.payload.id` igual ao ID
  no nome do arquivo.
- Alguns arquivos antigos não têm `session_meta`.
- Alguns arquivos podem ter mais de um registro `session_meta`.

## 17. Campos de topo

Inventariar campos top-level:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r 'keys[]' |
  sort |
  uniq -c |
  sort -nr
```

Campos top-level observados:

```text
535713 type
534127 timestamp
534108 payload
1223   record_type
1152   call_id
1047   id
576    output
576    name
576    arguments
453    content
371    summary
371    encrypted_content
82     role
19     instructions
19     git
```

Leitura prática:

- `type`, `timestamp` e `payload` indicam o formato envelopado atual.
- `record_type` aparece em marcadores de estado legados.
- `call_id`, `name`, `arguments` e `output` no topo aparecem em chamadas de
  ferramenta legadas.
- `content`, `role`, `summary` e `encrypted_content` no topo aparecem em
  mensagens/raciocínio legados.

## 18. Detalhe de `session_meta`

Campos de `session_meta.payload` observados:

```text
1029 timestamp
1029 originator
1029 id
1029 cwd
1029 cli_version
1027 source
985  model_provider
695  base_instructions
543  git
334  instructions
51   agent_role
51   agent_nickname
13   forked_from_id
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="session_meta") |
    (.payload | keys[])
  ' |
  sort |
  uniq -c |
  sort -nr
```

Origens observadas:

```text
706 codex_cli_rs
308 codex-tui
15  codex_exec
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="session_meta") |
    (.payload.originator // "__missing__")
  ' |
  sort |
  uniq -c |
  sort -nr
```

`model_provider` observado:

```text
985 openai
44  __missing__
```

Campos de `payload.git`, quando presentes:

```text
commit_hash
branch
repository_url
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="session_meta" and (.payload.git|type)=="object") |
    .payload.git | keys[]
  ' |
  sort |
  uniq -c |
  sort -nr
```

## 19. Subagentes

Sessões de subagente foram identificadas por `session_meta.payload.source` como
objeto com chave `subagent`.

Tipos de `source` observados:

```text
960 cli
51  object:subagent
15  exec
2   __null
1   unknown
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="session_meta") |
    (.payload.source|type) as $t |
    if $t=="string" then
      .payload.source
    elif $t=="object" then
      "object:" + ((.payload.source|keys|sort|join(",")))
    else
      "__" + $t
    end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Campos escalares observados em `payload.source.subagent.thread_spawn`:

```text
subagent.thread_spawn.parent_thread_id
subagent.thread_spawn.depth
subagent.thread_spawn.agent_role
subagent.thread_spawn.agent_nickname
```

Roles observados:

```text
32 explorer
19 awaiter
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="session_meta" and (.payload.source|type)=="object") |
    (.payload.source.subagent.thread_spawn.agent_role // .payload.agent_role // "__missing__")
  ' |
  sort |
  uniq -c |
  sort -nr
```

Para listar subagentes com relação pai-filho:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg file "$f" '
    select(.type=="session_meta" and (.payload.source|type)=="object") |
    [
      .payload.timestamp,
      .payload.id,
      (.payload.source.subagent.thread_spawn.parent_thread_id // ""),
      (.payload.source.subagent.thread_spawn.agent_role // ""),
      (.payload.source.subagent.thread_spawn.agent_nickname // ""),
      $file
    ] | @tsv
  ' "$f"
done |
sort
```

## 20. Detalhe de `turn_context`

Campos de `turn_context.payload` observados:

```text
40066 summary
40066 sandbox_policy
40066 model
40066 cwd
40066 approval_policy
35557 effort
25328 truncation_policy
24880 user_instructions
18345 collaboration_mode
14129 personality
9231  turn_id
2609  timezone
2609  current_date
2571  realtime_active
375   permission_profile
79    developer_instructions
5     file_system_sandbox_policy
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="turn_context") |
    (.payload | keys[])
  ' |
  sort |
  uniq -c |
  sort -nr
```

Modelos observados:

```text
11331 gpt-5.2-codex
9433  gpt-5.3-codex
6243  gpt-5-codex
4816  gpt-5.1-codex-max
4357  gpt-5.2
2152  gpt-5.4
739   gpt-5.1-codex
356   gpt-5.1
295   gpt-5.5
168   gpt-5
97    gpt-5.1-codex-mini
74    gpt-5.3-codex-spark
3     gpt-5.4-mini
```

Modos de colaboração observados:

```text
21721 __missing__
12607 default
4216  custom
1229  code
293   plan
```

Políticas de aprovação observadas:

```text
37785 never
2281  on-request
```

Sandbox observado:

```text
37769 danger-full-access
2284  workspace-write
13    read-only
```

Esforços de raciocínio observados:

```text
16788 high
9943  xhigh
8699  medium
4509  __missing__
127   low
```

## 21. Blocos de conteúdo das mensagens

Em `response_item.payload.type == "message"`, os blocos de conteúdo observados
foram:

```text
21198 output_text
10418 input_text
25    input_image
```

Em mensagens legadas de topo (`type == "message"`):

```text
43 output_text
39 input_text
```

Comandos:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="response_item" and .payload.type=="message") |
    .payload.content[]?.type // "__missing__"
  ' |
  sort |
  uniq -c |
  sort -nr
```

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="message") |
    .content[]?.type // "__missing__"
  ' |
  sort |
  uniq -c |
  sort -nr
```

Interpretação:

- `input_text`: texto enviado pelo usuário ou por contexto de entrada.
- `output_text`: texto produzido pelo assistente.
- `input_image`: imagem anexada ou disponibilizada para o modelo.

## 22. Detalhe de `response_item`

Subtipos observados:

```text
89928 function_call
89910 function_call_output
61266 reasoning
29722 message
6685  custom_tool_call_output
6685  custom_tool_call
1961  web_search_call
177   ghost_snapshot
17    tool_search_output
17    tool_search_call
```

Campos por subtipo mais relevantes:

```text
function_call:        type, name, call_id, arguments, namespace
function_call_output: type, output, call_id
reasoning:            type, summary, encrypted_content, content
message:              type, role, content, phase
custom_tool_call:     type, status, name, input, call_id
custom_tool_call_out: type, output, call_id
web_search_call:      type, status, action
ghost_snapshot:       type, ghost_commit
tool_search_call:     type, status, execution, call_id, arguments
tool_search_output:   type, status, execution, call_id, tools
```

Comando para inventariar campos por subtipo:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="response_item") |
    (.payload.type // "__missing__") as $t |
    (.payload | keys[] | $t + "\t" + .)
  ' |
  sort |
  uniq -c |
  sort -nr
```

Nomes de função mais frequentes observados:

```text
53722 exec_command
15890 write_stdin
11095 shell_command
5809  shell
1106  update_plan
299   mcp__playwright__browser_navigate
287   mcp__playwright__browser_click
257   request_user_input
162   mcp__playwright__browser_run_code
153   mcp__playwright__browser_wait_for
131   mcp__playwright__browser_snapshot
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="response_item" and .payload.type=="function_call") |
    .payload.name
  ' |
  sort |
  uniq -c |
  sort -nr |
  head -50
```

## 23. Detalhe de `event_msg`

Subtipos observados:

```text
110372 token_count
34349  agent_reasoning
26142  exec_command_end
20956  agent_message
4985   user_message
2998   task_started
2683   task_complete
1586   patch_apply_end
660    web_search_end
594    mcp_tool_call_end
548    turn_aborted
254    item_completed
241    context_compacted
14     view_image_tool_call
8      collab_agent_spawn_end
7      collab_waiting_end
1      error
```

Comando para inventariar campos por subtipo:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg") |
    (.payload.type // "__missing__") as $t |
    (.payload | keys[] | $t + "\t" + .)
  ' |
  sort |
  uniq -c |
  sort -nr
```

Campos importantes por subtipo:

```text
token_count:            info, rate_limits
agent_reasoning:        text
exec_command_end:       call_id, command, cwd, exit_code, stdout, stderr,
                         formatted_output, aggregated_output, duration, status
agent_message:          message, phase, memory_citation
user_message:           message, images, local_images, text_elements, kind
task_started:           turn_id, model_context_window, collaboration_mode_kind
task_complete:          turn_id, last_agent_message, duration_ms,
                         completed_at, time_to_first_token_ms
patch_apply_end:        call_id, changes, success, stdout, stderr, status
web_search_end:         call_id, query, action
mcp_tool_call_end:      call_id, invocation, result, duration
turn_aborted:           reason, turn_id, duration_ms, completed_at
item_completed:         turn_id, thread_id, item
context_compacted:      type
view_image_tool_call:   call_id, path
collab_agent_spawn_end: call_id, new_thread_id, sender_thread_id,
                         new_agent_role, new_agent_nickname, status
collab_waiting_end:     call_id, sender_thread_id, statuses, agent_statuses
error:                  message, codex_error_info
```

Para listar eventos operacionais de uma sessão:

```bash
jq -r '
  select(.type=="event_msg") |
  [
    .timestamp,
    .payload.type,
    (.payload.turn_id // ""),
    (.payload.call_id // ""),
    (.payload.status // ""),
    (.payload.reason // "")
  ] | @tsv
' "$f"
```

## 24. Relacionar chamadas e resultados

O relacionamento principal entre chamada e resposta usa `call_id`.

Pares comuns:

```text
response_item.function_call.call_id
response_item.function_call_output.call_id
response_item.custom_tool_call.call_id
response_item.custom_tool_call_output.call_id
event_msg.exec_command_end.call_id
event_msg.patch_apply_end.call_id
event_msg.web_search_end.call_id
event_msg.mcp_tool_call_end.call_id
event_msg.view_image_tool_call.call_id
event_msg.collab_agent_spawn_end.call_id
event_msg.collab_waiting_end.call_id
```

Contagem aproximada de `call_id` únicos no transcript:

```text
89733 function_call ids
89728 function_call_output ids
```

Comando:

```bash
root="$HOME/.codex/sessions"

calls="$(
  find "$root" -type f -name '*.jsonl' -print0 |
    xargs -0 jq -r '
      select((.type=="response_item" and .payload.type=="function_call") or
             .type=="function_call") |
      (.payload.call_id // .call_id // empty)
    ' |
    sort -u |
    wc -l |
    tr -d " "
)"

outs="$(
  find "$root" -type f -name '*.jsonl' -print0 |
    xargs -0 jq -r '
      select((.type=="response_item" and .payload.type=="function_call_output") or
             .type=="function_call_output") |
      (.payload.call_id // .call_id // empty)
    ' |
    sort -u |
    wc -l |
    tr -d " "
)"

echo "unique_function_call_ids $calls"
echo "unique_function_output_ids $outs"
```

Para relacionar comandos executados com o transcript de chamadas em uma sessão:

```bash
jq -r '
  if .type=="response_item" and .payload.type=="function_call" then
    [
      "call",
      .timestamp,
      .payload.call_id,
      .payload.name,
      ((.payload.arguments // "") | if type=="string" then . else tojson end)
    ]
  elif .type=="event_msg" and .payload.type=="exec_command_end" then
    [
      "exec_end",
      .timestamp,
      .payload.call_id,
      (.payload.exit_code|tostring),
      ((.payload.command // "") | if type=="string" then . else tojson end)
    ]
  elif .type=="response_item" and .payload.type=="function_call_output" then
    [
      "output",
      .timestamp,
      .payload.call_id,
      "",
      ((.payload.output // "") | if type=="string" then . else tojson end | .[0:160])
    ]
  else
    empty
  end | @tsv
' "$f"
```

## 25. `exec_command_end`

`event_msg.exec_command_end` é o melhor lugar para auditar comandos shell, porque
guarda comando, diretório, código de saída e saídas.

Campos observados:

```text
aggregated_output
call_id
command
cwd
duration
exit_code
formatted_output
parsed_cmd
process_id
source
status
stderr
stdout
turn_id
type
```

Status e exit codes mais comuns:

```text
24019 unified_exec_startup completed 0
1372  unified_exec_startup failed    1
251   unified_exec_startup failed    2
125   unified_exec_startup failed    254
116   unified_exec_startup failed    128
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="exec_command_end") |
    (.payload.source // "__missing__") + "\t" +
    (.payload.status // "__missing__") + "\t" +
    ((.payload.exit_code // "null")|tostring)
  ' |
  sort |
  uniq -c |
  sort -nr |
  head -80
```

Listar comandos com erro:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="exec_command_end") |
    select((.payload.exit_code // 0) != 0) |
    [
      input_filename,
      .timestamp,
      (.payload.exit_code|tostring),
      (.payload.cwd // ""),
      ((.payload.command // "") | if type=="string" then . else tojson end)
    ] | @tsv
  '
```

## 26. `patch_apply_end`

`event_msg.patch_apply_end` registra aplicações de patch.

Campos observados:

```text
call_id
changes
status
stderr
stdout
success
turn_id
type
```

`payload.changes` é um objeto indexado por caminho de arquivo. Os valores
observados tiveram dois formatos:

```text
2367 move_path,type,unified_diff
960  content,type
```

Resumo da cardinalidade:

```text
1586 eventos patch_apply_end
3327 entradas em payload.changes
36 máximo de entradas em um único evento
```

Comandos:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="patch_apply_end") |
    .payload.changes[]? |
    if type=="object" then (keys|sort|join(",")) else . end
  ' |
  sort |
  uniq -c |
  sort -nr
```

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="patch_apply_end") |
    (.payload.changes | length)
  ' |
  awk '
    {
      if ($1==0) z++; else nz++;
      sum+=$1;
      if ($1>max) max=$1
    }
    END {
      print "zero", z+0;
      print "nonzero", nz+0;
      print "sum", sum+0;
      print "max", max+0
    }
  '
```

## 27. Busca web e MCP

`response_item.web_search_call` registra a intenção/chamada de busca no
transcript. `event_msg.web_search_end` registra o término do evento.

Formatos de `action` observados em `response_item.web_search_call`:

```text
1055 queries,query,type
609  type,url
150  pattern,type,url
95   type
26   pattern,type
16   null
10   query,type
```

Formatos de `action` observados em `event_msg.web_search_end`:

```text
342 queries,query,type
220 type,url
53  pattern,type,url
36  type
9   pattern,type
```

Comando:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="response_item" and .payload.type=="web_search_call") |
    (.payload.action|type) as $t |
    if $t=="object" then (.payload.action|keys|sort|join(",")) else $t end
  ' |
  sort |
  uniq -c |
  sort -nr
```

`event_msg.mcp_tool_call_end` usa:

```text
call_id
duration
invocation
result
type
```

E `payload.invocation` teve chaves:

```text
tool
server
arguments
```

Listar servidores/ferramentas MCP sem imprimir argumentos:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="mcp_tool_call_end") |
    [
      .timestamp,
      (.payload.invocation.server // ""),
      (.payload.invocation.tool // ""),
      (.payload.duration // "")
    ] | @tsv
  '
```

## 28. Compactação, snapshots e estado legado

Há três sinais diferentes relacionados a compactação/estado:

```text
event_msg.context_compacted
compacted
response_item.ghost_snapshot
```

`event_msg.context_compacted` observado:

```text
241 registros
payload: apenas type
```

`type == "compacted"` observado:

```text
247 registros
payload.message
payload.replacement_history
```

`response_item.ghost_snapshot` observado:

```text
177 registros
payload.ghost_commit
```

Comandos:

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="compacted") |
    (.payload|keys[]?)
  ' |
  sort |
  uniq -c |
  sort -nr
```

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="response_item" and .payload.type=="ghost_snapshot") |
    (.payload|keys[]?)
  ' |
  sort |
  uniq -c |
  sort -nr
```

Registros sem `type` observados:

```text
1223 record_type
19   git,id,instructions,timestamp
```

O caso dominante foi:

```json
{"record_type":"state"}
```

Esses registros funcionam como marcadores/estado legado e não são mensagens de
chat.

## 29. Consultas por navegação

### Sessões por intervalo UTC

Como os timestamps internos são UTC, esta consulta usa `session_meta.payload.timestamp`:

```bash
from="2026-04-01T00:00:00Z"
to="2026-05-01T00:00:00Z"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg from "$from" --arg to "$to" --arg file "$f" '
    select(.type=="session_meta") |
    select(.payload.timestamp >= $from and .payload.timestamp < $to) |
    [.payload.timestamp, .payload.id, (.payload.cwd // ""), $file] | @tsv
  ' "$f"
done |
sort
```

### Sessões por branch Git

```bash
branch="main"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg branch "$branch" --arg file "$f" '
    select(.type=="session_meta" and (.payload.git|type)=="object") |
    select((.payload.git.branch // "") == $branch) |
    [
      .payload.timestamp,
      .payload.id,
      (.payload.git.branch // ""),
      (.payload.cwd // ""),
      $file
    ] | @tsv
  ' "$f"
done |
sort
```

### Sessões que fizeram alteração de arquivo

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -e '
    select(.type=="event_msg" and .payload.type=="patch_apply_end")
  ' "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
done
```

### Sessões que executaram MCP

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -e '
    select(.type=="event_msg" and .payload.type=="mcp_tool_call_end")
  ' "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
done
```

### Sessões abortadas/interrompidas

```bash
find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
  xargs -0 jq -r '
    select(.type=="event_msg" and .payload.type=="turn_aborted") |
    [
      input_filename,
      .timestamp,
      (.payload.turn_id // ""),
      (.payload.reason // "")
    ] | @tsv
  '
```

No ambiente analisado, `turn_aborted.reason` foi:

```text
548 interrupted
```

## 30. Índice normalizado de sessões

Como não há `sessions-index.json`, o índice precisa ser derivado dos JSONL.
Este comando gera um JSONL com uma entrada por arquivo:

```bash
out="$HOME/.codex/analysis/codex-sessions-index.jsonl"
mkdir -p "$(dirname "$out")"

find ~/.codex/sessions -type f -name '*.jsonl' -print0 |
while IFS= read -r -d '' f; do
  jq -rs --arg file "$f" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    def user_text:
      if .type=="response_item" and .payload.type=="message" and .payload.role=="user" then
        text_content(.payload.content)
      elif .type=="message" and .role=="user" then
        text_content(.content)
      elif .type=="event_msg" and .payload.type=="user_message" then
        .payload.message // ""
      else
        empty
      end;

    {
      file: $file,
      session_id: ([.[] | select(.type=="session_meta") | .payload.id][0] // null),
      created_utc: ([.[] | select(.type=="session_meta") | .payload.timestamp][0] // null),
      cwd: (
        [.[] | select(.type=="session_meta") | .payload.cwd][0] //
        [.[] | select(.type=="turn_context") | .payload.cwd][0] //
        null
      ),
      cli_version: ([.[] | select(.type=="session_meta") | .payload.cli_version][0] // null),
      originator: ([.[] | select(.type=="session_meta") | .payload.originator][0] // null),
      source: ([.[] | select(.type=="session_meta") | .payload.source][0] // null),
      model_first: ([.[] | select(.type=="turn_context") | .payload.model][0] // null),
      model_last: ([.[] | select(.type=="turn_context") | .payload.model] | last // null),
      turn_count: ([.[] | select(.type=="turn_context")] | length),
      message_count: ([.[] | select((.type=="response_item" and .payload.type=="message") or .type=="message")] | length),
      event_message_count: ([.[] | select(.type=="event_msg" and (.payload.type=="user_message" or .payload.type=="agent_message"))] | length),
      function_call_count: ([.[] | select(.type=="response_item" and .payload.type=="function_call")] | length),
      exec_command_count: ([.[] | select(.type=="event_msg" and .payload.type=="exec_command_end")] | length),
      patch_count: ([.[] | select(.type=="event_msg" and .payload.type=="patch_apply_end")] | length),
      first_user: ([.[] | user_text][0] // null)
    }
  ' "$f"
done > "$out"
```

Consultar esse índice:

```bash
jq -r '
  [
    .created_utc,
    .session_id,
    .model_last,
    .turn_count,
    .message_count,
    .cwd,
    (.first_user // "" | gsub("\n"; " ") | .[0:180]),
    .file
  ] | @tsv
' "$HOME/.codex/analysis/codex-sessions-index.jsonl" |
sort
```

## 31. Conclusão

Para recuperar e pesquisar chats do Codex, os arquivos principais são os
`rollout-*.jsonl` em `~/.codex/sessions/YYYY/MM/DD`.

O caminho mais confiável é:

1. Usar `session_meta` para identificar sessão, diretório, versão, origem e Git.
2. Usar `turn_context` para modelo, modo, sandbox, política de aprovação e cwd
   por turno.
3. Usar `response_item.message` e `event_msg.user_message/agent_message` para
   recuperar conversa.
4. Usar `call_id` para relacionar chamadas de ferramenta com outputs e eventos
   operacionais.
5. Usar `payload.source.subagent.thread_spawn.parent_thread_id` para ligar
   subagentes à sessão pai.

O formato é mais simples em arquivos do que o do Claude Code, porque não há
índice por projeto nem artefatos externos em `sessions`, mas o JSONL é mais rico
em eventos operacionais e exige separar cuidadosamente transcript, UI events,
ferramentas, compactação e registros legados.
