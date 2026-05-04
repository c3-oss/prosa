# Como ler `~/.gemini/tmp` do Gemini CLI

Data da investigação: 2026-05-03

Este documento descreve o processo usado para entender e consultar os arquivos
temporários locais do Gemini CLI em:

```text
~/.gemini/tmp/
```

O objetivo foi descobrir:

- como a árvore em `tmp` é organizada;
- quais arquivos guardam chats, logs e metadados de projeto;
- qual schema os JSON usam;
- como relacionar diretórios, `projectHash`, `sessionId` e nomes de arquivo;
- como pesquisar mensagens, respostas e chamadas de ferramenta;
- como gerar índices normalizados para consulta posterior.

Este documento evita depender do conteúdo específico das conversas. Os comandos
mostram a técnica e os formatos.

## Resumo

O Gemini CLI, no diretório analisado, usa arquivos JSON comuns, não JSONL.

Resumo do diretório:

```text
12 MB total
49 diretórios
92 arquivos
80 arquivos .json válidos
56 arquivos de chat em chats/session-*.json
24 arquivos logs.json
10 arquivos .project_root
1 binário bin/rg
1 arquivo .DS_Store
```

Estrutura geral observada:

```text
~/.gemini/tmp/
  <project-hash-ou-slug>/
    logs.json
    .project_root
    chats/
      session-<data>T<hora>-<session-prefix>.json
  bin/
    rg
```

No conjunto analisado:

```text
19 diretórios hash SHA-256-like de 64 hex
10 diretórios nomeados por slug de projeto
1 diretório bin
273 registros em logs.json
612 mensagens em chats/session-*.json
443 chamadas de ferramenta
964 itens de thoughts
```

Janelas temporais observadas:

```text
logs.json: 2025-07-18T17:46:55.308Z até 2026-04-14T23:47:03.971Z
chats:     2025-11-03T20:22:32.178Z até 2026-04-27T20:00:29.511Z
```

Interpretação prática:

- `logs.json` é um array de eventos de entrada do usuário.
- `chats/session-*.json` é o histórico de uma sessão, com mensagens e chamadas
  de ferramenta.
- `.project_root` aparece em diretórios nomeados e guarda o path real do projeto.
- Diretórios hash não têm `.project_root` no conjunto analisado; nesses casos,
  use `projectHash` dos chats e o próprio diretório como identificador.
- `bin/rg` é uma cópia local do ripgrep usada pelo Gemini CLI.

## 1. Descoberta inicial

Contar arquivos e diretórios:

```bash
find ~/.gemini/tmp -type f | wc -l
find ~/.gemini/tmp -type d | wc -l
du -sh ~/.gemini/tmp
```

Classificar arquivos:

```bash
find ~/.gemini/tmp -maxdepth 4 -type f |
while read -r f; do
  rel=${f#$HOME/.gemini/tmp/}
  case "$rel" in
    */logs.json) echo logs_json ;;
    */chats/session-*.json) echo chat_json ;;
    */.project_root) echo project_root ;;
    bin/*) echo bin ;;
    *.DS_Store) echo ds_store ;;
    *) echo other ;;
  esac
done |
sort |
uniq -c
```

No ambiente analisado:

```text
56 chat_json
24 logs_json
10 project_root
1  bin
1  ds_store
```

Validar todos os JSON:

```bash
find ~/.gemini/tmp -type f -name '*.json' -print0 |
while IFS= read -r -d '' f; do
  jq empty "$f" >/dev/null 2>&1 || printf '%s\n' "$f"
done
```

Resultado esperado quando todos validam: nenhuma linha.

Contar tipos de arquivo:

```bash
find ~/.gemini/tmp -type f |
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
80 .json
10 .project_root
1  __no_ext__
1  .DS_Store
```

## 2. Estrutura de diretórios

Diretórios de primeiro nível observados:

```bash
find ~/.gemini/tmp -mindepth 1 -maxdepth 1 -type d |
awk '
  {
    n=$0
    sub(/^.*\//, "", n)
    if (n=="bin") bin++
    else if (n ~ /^[0-9a-f]{64}$/) hash++
    else named++
  }
  END {
    print "hash_dirs", hash+0
    print "named_dirs", named+0
    print "bin_dirs", bin+0
  }
'
```

No ambiente analisado:

```text
hash_dirs 19
named_dirs 10
bin_dirs 1
```

Formato hash:

```text
~/.gemini/tmp/<64-hex>/
  logs.json
  chats/
    session-....json
```

Formato nomeado:

```text
~/.gemini/tmp/<project-slug>/
  .project_root
  logs.json
  chats/
    session-....json
```

`bin/rg`:

```bash
file ~/.gemini/tmp/bin/rg
~/.gemini/tmp/bin/rg --version | head -3
```

No ambiente analisado:

```text
Mach-O 64-bit executable arm64
ripgrep 13.0.0
```

## 3. `.project_root`

`.project_root` guarda o path real do projeto para diretórios nomeados.

Listar:

```bash
find ~/.gemini/tmp -name .project_root -print0 |
while IFS= read -r -d '' f; do
  dir="$(basename "$(dirname "$f")")"
  root="$(tr -d '\n' < "$f")"
  printf '%s\t%s\n' "$dir" "$root"
done |
sort
```

No ambiente analisado:

```text
brain                /Users/upsetbit/Projects/_me/upsetbit/BRAIN
c3-corp              /Users/upsetbit/Projects/c3/c3-corp
foreach-agent-tests  /private/tmp/foreach-agent-tests
mz-iac               /Users/upsetbit/Projects/MZ/mz-iac
mz-operator-1        /Users/upsetbit/Projects/MZ/mz-operator-1
naiac                /Users/upsetbit/Projects/naiac
sites                /Users/upsetbit/Projects/MZ/sites
sk-js                /Users/upsetbit/Projects/c3/c3-oss/sk.js
squad-data           /Users/upsetbit/Projects/MZ/squad-data
wp-replacement       /Users/upsetbit/Projects/MZ/squad-staff/wp-replacement
```

Observações:

- Alguns arquivos `.project_root` não terminam com newline; use `tr -d '\n'`
  ou `printf` para não misturar linhas ao listar.
- Diretórios hash não tinham `.project_root` no conjunto analisado.

## 4. `logs.json`

Cada `logs.json` é um array JSON.

Verificar tipo:

```bash
find ~/.gemini/tmp -name logs.json -print0 |
  xargs -0 jq -r 'type' |
  sort |
  uniq -c
```

No ambiente analisado:

```text
24 array
```

Campos dos registros:

```bash
find ~/.gemini/tmp -name logs.json -print0 |
  xargs -0 jq -r '.[] | keys[]' |
  sort |
  uniq -c |
  sort -nr
```

Resultado:

```text
273 type
273 timestamp
273 sessionId
273 messageId
273 message
```

Formato típico:

```json
{
  "sessionId": "uuid-da-sessao",
  "messageId": 0,
  "type": "user",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "message": "..."
}
```

Tipos observados:

```bash
find ~/.gemini/tmp -name logs.json -print0 |
  xargs -0 jq -r '.[] | .type' |
  sort |
  uniq -c |
  sort -nr
```

No ambiente analisado:

```text
273 user
```

Tipos dos campos:

```text
message:   string
messageId: number
sessionId: string de 36 caracteres
timestamp: string ISO UTC
```

Interpretação:

- `logs.json` é útil para localizar prompts do usuário e sessões antigas.
- Ele não contém respostas do modelo.
- `messageId` é numérico e local ao log; não bate com `messages[].id` dos
  arquivos de chat, que são UUIDs.

## 5. `chats/session-*.json`

Cada arquivo de chat é um objeto JSON.

Verificar tipo:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r 'type' |
  sort |
  uniq -c
```

No ambiente analisado:

```text
56 object
```

Campos top-level:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r 'keys[]' |
  sort |
  uniq -c |
  sort -nr
```

Resultado:

```text
56 startTime
56 sessionId
56 projectHash
56 messages
56 lastUpdated
9  kind
6  summary
```

Formato típico:

```json
{
  "sessionId": "uuid-da-sessao",
  "projectHash": "hash-do-projeto",
  "startTime": "2026-01-01T00:00:00.000Z",
  "lastUpdated": "2026-01-01T00:10:00.000Z",
  "messages": []
}
```

Contar sessões por mês pelo nome do arquivo:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' |
  sed -E 's#.*/session-([0-9]{4})-([0-9]{2}).*#\1-\2#' |
  sort |
  uniq -c
```

No ambiente analisado:

```text
16 2025-11
6  2025-12
16 2026-01
9  2026-02
6  2026-03
3  2026-04
```

## 6. Identidade da sessão

O nome do arquivo usa este padrão:

```text
session-<YYYY-MM-DD>T<HH-MM>-<session-prefix>.json
```

Exemplo:

```text
session-2026-04-27T19-59-62819ffe.json
```

O sufixo de 8 caracteres bate com os primeiros 8 caracteres de `.sessionId`.

Verificar:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  sid="$(jq -r '.sessionId' "$f")"
  short="$(printf '%s' "$sid" | cut -c1-8)"
  suffix="$(
    basename "$f" .json |
      sed -E 's/^session-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-//'
  )"
  [ "$short" = "$suffix" ] && echo match || echo mismatch
done |
sort |
uniq -c
```

No ambiente analisado:

```text
56 match
```

Há `sessionId` repetidos em mais de um arquivo:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '.sessionId' |
  sort |
  uniq -c |
  awk '$1>1'
```

No ambiente analisado:

```text
2 12d65a07-ec90-4b73-8cbd-1ca32ab29308
2 1e5de3e9-be22-45e6-9e56-64bd4a07f1aa
2 7ef2f0bf-50e5-487e-b025-102fa1348b3d
```

Interpretação:

- O `sessionId` é o identificador lógico.
- O nome do arquivo também inclui data/hora, então um mesmo `sessionId` pode ter
  mais de um arquivo.
- Para deduplicar sessões, agrupe por `.sessionId`; para preservar snapshots,
  mantenha o arquivo.

## 7. `projectHash` e diretório

Em diretórios hash, o nome do diretório geralmente bate com `.projectHash`.
Em diretórios nomeados, `.projectHash` continua sendo um hash e não bate com o
slug.

Verificar:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  dir="$(basename "$(dirname "$(dirname "$f")")")"
  ph="$(jq -r '.projectHash' "$f")"
  if [ "$dir" = "$ph" ]; then
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
41 match
15 mismatch
```

Os `mismatch` eram sessões em diretórios nomeados, como `mz-iac`, `sk-js`,
`wp-replacement`, `sites` e similares. Para esses, use `.project_root` para o
path real e `.projectHash` para o identificador interno.

Contar sessões por `projectHash`:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '.projectHash' |
  sort |
  uniq -c |
  sort -nr
```

## 8. Mensagens de chat

`messages` é um array dentro de cada arquivo de chat.

Campos por mensagem:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '.messages[]? | keys[]' |
  sort |
  uniq -c |
  sort -nr
```

No ambiente analisado:

```text
612 type
612 timestamp
612 id
612 content
425 thoughts
425 model
423 tokens
355 toolCalls
7   displayContent
```

Tipos de mensagem:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '.messages[]? | (.type // "__missing__")' |
  sort |
  uniq -c |
  sort -nr
```

No ambiente analisado:

```text
425 gemini
120 user
50  info
17  error
```

Campos por tipo:

```text
gemini: type, timestamp, id, content, model, thoughts, tokens, toolCalls
user:   type, timestamp, id, content, displayContent
info:   type, timestamp, id, content
error:  type, timestamp, id, content
```

`content` observado:

```text
592 string
20  array
```

Quando `content` é array, os itens observados eram objetos com chave `text`.

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.content|type=="array") |
    .content[]? |
    if type=="object" then keys|sort|join(",") else type end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Resultado:

```text
128 text
```

## 9. Extrair mensagens

Extrair mensagens de uma sessão para TSV:

```bash
f="/ABSOLUTE/PATH/session-....json"

jq -r '
  def text_content($c):
    if ($c|type) == "array" then
      [$c[]? | .text? // empty] | join("\n")
    elif ($c|type) == "string" then
      $c
    else
      ""
    end;

  .messages[]? |
  [
    .timestamp,
    .type,
    .id,
    text_content(.content)
  ] | @tsv
' "$f"
```

Extrair só mensagens conversacionais (`user` e `gemini`):

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

  .messages[]? |
  select(.type=="user" or .type=="gemini") |
  [.timestamp, .type, text_content(.content)] | @tsv
' "$f"
```

Exportar uma sessão para Markdown:

```bash
f="/ABSOLUTE/PATH/session-....json"
out="/tmp/gemini-session.md"

jq -r '
  def text_content($c):
    if ($c|type) == "array" then
      [$c[]? | .text? // empty] | join("\n")
    elif ($c|type) == "string" then
      $c
    else
      ""
    end;

  .messages[]? |
  select(.type=="user" or .type=="gemini" or .type=="info" or .type=="error") |
  "## " + (.type | ascii_upcase) + "\n\n" + text_content(.content) + "\n"
' "$f" > "$out"
```

## 10. Pesquisar por texto bruto

Busca rápida em todo `tmp`:

```bash
rg -n -i "termo de busca" ~/.gemini/tmp
```

Buscar só arquivos que contêm o termo:

```bash
rg -l -i "termo de busca" ~/.gemini/tmp
```

Restringir a chats:

```bash
rg -n -i "termo de busca" ~/.gemini/tmp/*/chats
```

Observações:

- `rg` é o jeito mais rápido para localizar candidatos.
- A saída bruta pode conter prompts, respostas, código, comandos e dados
  sensíveis.
- Depois de localizar arquivos, use `jq` para extrair campos específicos.

## 11. Pesquisar apenas em chats

Pesquisar termo em `messages[].content`:

```bash
q="termo de busca"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    .messages[]? |
    {
      file: input_filename,
      ts: .timestamp,
      type: .type,
      id: .id,
      text: text_content(.content)
    } |
    select(.text | test($q; "i")) |
    [
      .ts,
      .type,
      .file,
      (.text | gsub("\n"; " ") | .[0:240])
    ] | @tsv
  '
```

Pesquisar só prompts do usuário nos chats:

```bash
q="termo de busca"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    .messages[]? |
    select(.type=="user") |
    {
      file: input_filename,
      ts: .timestamp,
      text: text_content(.content)
    } |
    select(.text | test($q; "i")) |
    [.ts, .file, (.text | gsub("\n"; " ") | .[0:240])] | @tsv
  '
```

Pesquisar em `logs.json`:

```bash
q="termo de busca"

find ~/.gemini/tmp -name logs.json -print0 |
  xargs -0 jq -r --arg q "$q" '
    .[] |
    select((.message // "") | test($q; "i")) |
    [
      input_filename,
      .timestamp,
      .sessionId,
      (.messageId|tostring),
      (.message | gsub("\n"; " ") | .[0:240])
    ] | @tsv
  '
```

## 12. Modelos e tokens

Modelos observados em mensagens `gemini`:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.type=="gemini") |
    (.model // "__missing__")
  ' |
  sort |
  uniq -c |
  sort -nr
```

No ambiente analisado:

```text
205 gemini-3-pro-preview
122 gemini-2.5-pro
63  gemini-3-flash-preview
34  gemini-2.5-flash
1   gemini-2.5-flash-lite
```

`tokens` aparece em mensagens `gemini`:

```text
423 object
189 null
```

Campos de `tokens`:

```text
cached
input
output
thoughts
tool
total
```

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.tokens|type=="object") |
    .tokens | keys[]
  ' |
  sort |
  uniq -c |
  sort -nr
```

Somar tokens por modelo:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.type=="gemini" and (.tokens|type)=="object") |
    [
      (.model // "__missing__"),
      (.tokens.input // 0),
      (.tokens.output // 0),
      (.tokens.thoughts // 0),
      (.tokens.tool // 0),
      (.tokens.cached // 0),
      (.tokens.total // 0)
    ] | @tsv
  ' |
awk -F'\t' '
  {
    in_tok[$1]+=$2
    out_tok[$1]+=$3
    thoughts[$1]+=$4
    tool[$1]+=$5
    cached[$1]+=$6
    total[$1]+=$7
  }
  END {
    for (m in total)
      print m, in_tok[m], out_tok[m], thoughts[m], tool[m], cached[m], total[m]
  }
'
```

## 13. `thoughts`

`thoughts` aparece em mensagens `gemini` como array.

Tipos observados:

```text
425 array
187 null
```

Itens de `thoughts` observados:

```text
964 description,subject,timestamp
```

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.thoughts|type=="array") |
    .thoughts[]? |
    if type=="object" then keys|sort|join(",") else type end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Listar apenas metadados de `thoughts`, sem descrição:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.thoughts|type=="array") |
    .thoughts[]? |
    [
      input_filename,
      (.timestamp // ""),
      (.subject // "")
    ] | @tsv
  '
```

## 14. Chamadas de ferramenta

`toolCalls` aparece em mensagens `gemini`.

Tipos:

```text
355 array
257 null
```

Campos observados por chamada:

```text
args
description
displayName
id
name
renderOutputAsMarkdown
result
resultDisplay
status
timestamp
```

Em parte das chamadas, `resultDisplay` não aparece.

Ferramentas observadas:

```text
133 replace
112 read_file
86  run_shell_command
50  write_file
36  list_directory
6   google_web_search
5   write_todos
4   read_many_files
3   search_file_content
3   glob
2   codebase_investigator
1   grep_search
1   browser_navigate
1   ask_user
```

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.toolCalls|type=="array") |
    .toolCalls[]? |
    (.name // .toolName // .type // "__missing__")
  ' |
  sort |
  uniq -c |
  sort -nr
```

Status:

```text
403 success
32  error
8   cancelled
```

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.toolCalls|type=="array") |
    .toolCalls[]? |
    (.status // "__missing__")
  ' |
  sort |
  uniq -c |
  sort -nr
```

## 15. Argumentos de ferramentas

`args` sempre apareceu como objeto.

Campos frequentes por ferramenta:

```text
replace:           file_path, instruction, old_string, new_string,
                   expected_replacements
read_file:         file_path, absolute_path, limit
run_shell_command: command, description, dir_path, directory
write_file:        file_path, content, instruction
list_directory:    dir_path, path
google_web_search: query
write_todos:       todos
read_many_files:   paths
search_file_content: pattern
glob:              pattern
codebase_investigator: objective
grep_search:       dir_path, include, pattern
browser_navigate:  url
ask_user:          questions
```

Comando para inventariar:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.toolCalls|type=="array") |
    .toolCalls[]? |
    .name as $n |
    .args |
    if type=="object" then
      keys[] | $n + "\t" + .
    else
      $n + "\t__" + type
    end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Listar comandos shell sem imprimir saída:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.toolCalls|type=="array") |
    .toolCalls[]? |
    select(.name=="run_shell_command") |
    [
      input_filename,
      .timestamp,
      (.status // ""),
      (.args.dir_path // .args.directory // ""),
      (.args.command // "")
    ] | @tsv
  '
```

Listar arquivos alterados por `replace` e `write_file`:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    select(.toolCalls|type=="array") |
    .toolCalls[]? |
    select(.name=="replace" or .name=="write_file") |
    [
      input_filename,
      .timestamp,
      .name,
      (.status // ""),
      (.args.file_path // "")
    ] | @tsv
  '
```

## 16. Resultados de ferramentas

`result` sempre apareceu como array.

Resumo por ferramenta:

```text
133 replace              1 resultado por chamada
112 read_file            1 resultado por chamada
86  run_shell_command    1 resultado por chamada
50  write_file           1 resultado por chamada
36  list_directory       1 resultado por chamada
6   google_web_search    1 resultado por chamada
5   write_todos          1 resultado por chamada
4   read_many_files      até 6 resultados por chamada
```

Itens de `result`:

```text
functionResponse
text
```

`functionResponse` usa:

```text
id
name
response
```

`functionResponse.response` usa principalmente:

```text
output
error
```

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    .toolCalls[]? |
    .name as $n |
    .result[]? |
    select(.functionResponse? != null) |
    .functionResponse.response |
    if type=="object" then
      keys[] | $n + "\t" + .
    else
      $n + "\t__" + type
    end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Listar falhas de ferramentas sem despejar output completo:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    .toolCalls[]? |
    select(.status=="error") |
    [
      input_filename,
      .timestamp,
      .name,
      (.args.file_path // .args.dir_path // .args.directory // ""),
      (
        [.result[]?.functionResponse?.response?.error? // empty] |
        join("\n") |
        gsub("\n"; " ") |
        .[0:240]
      )
    ] | @tsv
  '
```

## 17. `resultDisplay` e diffs

`resultDisplay` apareceu como string ou objeto:

```text
271 string
54  object
```

Quando objeto, as chaves observadas foram:

```text
diffStat
fileDiff
fileName
filePath
isNewFile
newContent
originalContent
```

Isso aparece principalmente em operações de edição de arquivo.

Comando:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    .toolCalls[]? |
    select(.resultDisplay != null) |
    if (.resultDisplay|type)=="object" then
      (.resultDisplay|keys|sort|join(","))
    else
      (.resultDisplay|type)
    end
  ' |
  sort |
  uniq -c |
  sort -nr
```

Listar arquivos com diff em `resultDisplay`:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    .toolCalls[]? |
    select(.resultDisplay|type=="object") |
    [
      input_filename,
      .timestamp,
      .name,
      (.status // ""),
      (.resultDisplay.filePath // ""),
      (.resultDisplay.fileName // "")
    ] | @tsv
  '
```

## 18. Listar sessões

Gerar uma linha por arquivo de chat:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  dir="$(basename "$(dirname "$(dirname "$f")")")"
  root_file="$(dirname "$(dirname "$f")")/.project_root"
  project_root=""
  [ -f "$root_file" ] && project_root="$(tr -d '\n' < "$root_file")"

  jq -r --arg file "$f" --arg dir "$dir" --arg project_root "$project_root" '
    [
      .startTime,
      .lastUpdated,
      .sessionId,
      .projectHash,
      $dir,
      $project_root,
      (.messages|length),
      ([.messages[]?.toolCalls[]?] | length),
      (.summary // "" | gsub("\n"; " ") | .[0:180]),
      $file
    ] | @tsv
  ' "$f"
done |
sort
```

Listar sessões mais longas por número de mensagens:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    [
      (.messages|length),
      .startTime,
      .sessionId,
      input_filename
    ] | @tsv
  ' |
sort -nr |
head -20
```

Listar sessões com mais chamadas de ferramenta:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    [
      ([.messages[]?.toolCalls[]?] | length),
      .startTime,
      .sessionId,
      input_filename
    ] | @tsv
  ' |
sort -nr |
head -20
```

## 19. Filtrar por projeto, modelo ou data

Filtrar por diretório/slug:

```bash
project="mz-iac"

find ~/.gemini/tmp/"$project" -path '*/chats/session-*.json' -print
```

Filtrar por `.project_root`:

```bash
needle="/Users/upsetbit/Projects/MZ/mz-iac"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  root_file="$(dirname "$(dirname "$f")")/.project_root"
  [ -f "$root_file" ] || continue
  root="$(tr -d '\n' < "$root_file")"
  case "$root" in
    *"$needle"*) printf '%s\n' "$f" ;;
  esac
done
```

Filtrar por `projectHash`:

```bash
hash="72cc79b0ff736e86d1081e26cae9b525e546aba89428f2b2db3132bb053635d2"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  jq -e --arg hash "$hash" '.projectHash == $hash' "$f" >/dev/null 2>&1 &&
    printf '%s\n' "$f"
done
```

Filtrar por modelo:

```bash
model="gemini-3-pro-preview"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  jq -e --arg model "$model" '
    any(.messages[]?; .type=="gemini" and (.model // "") == $model)
  ' "$f" >/dev/null 2>&1 && printf '%s\n' "$f"
done
```

Filtrar por intervalo de `startTime`:

```bash
from="2026-03-01T00:00:00Z"
to="2026-04-01T00:00:00Z"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  jq -r --arg from "$from" --arg to "$to" --arg file "$f" '
    select(.startTime >= $from and .startTime < $to) |
    [.startTime, .sessionId, .projectHash, $file] | @tsv
  ' "$f"
done |
sort
```

## 20. Relacionar logs e chats

`logs.json` e `chats/session-*.json` compartilham `sessionId`, mas nem sempre há
arquivo de chat correspondente para cada sessão nos logs.

No ambiente analisado:

```text
53 sessionId únicos em chats
76 sessionId únicos em logs
37 sessionId em comum
```

Comando:

```bash
comm -12 \
  <(find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
      xargs -0 jq -r '.sessionId' | sort -u) \
  <(find ~/.gemini/tmp -name logs.json -print0 |
      xargs -0 jq -r '.[] | .sessionId' | sort -u) |
wc -l
```

Listar logs de uma sessão:

```bash
sid="uuid-da-sessao"

find ~/.gemini/tmp -name logs.json -print0 |
  xargs -0 jq -r --arg sid "$sid" '
    .[] |
    select(.sessionId == $sid) |
    [
      input_filename,
      .timestamp,
      (.messageId|tostring),
      (.type // ""),
      (.message | gsub("\n"; " ") | .[0:240])
    ] | @tsv
  '
```

## 21. Índice normalizado de sessões

Como não há um índice único equivalente ao `sessions-index.json`, gere um índice
derivado dos chats:

```bash
out="$HOME/.gemini/tmp-analysis/gemini-sessions-index.jsonl"
mkdir -p "$(dirname "$out")"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  dir="$(basename "$(dirname "$(dirname "$f")")")"
  root_file="$(dirname "$(dirname "$f")")/.project_root"
  project_root=""
  [ -f "$root_file" ] && project_root="$(tr -d '\n' < "$root_file")"

  jq -c --arg file "$f" --arg dir "$dir" --arg project_root "$project_root" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    {
      file: $file,
      dir: $dir,
      project_root: (if $project_root == "" then null else $project_root end),
      projectHash: .projectHash,
      sessionId: .sessionId,
      startTime: .startTime,
      lastUpdated: .lastUpdated,
      kind: (.kind // null),
      summary: (.summary // null),
      message_count: (.messages | length),
      user_count: ([.messages[]? | select(.type=="user")] | length),
      gemini_count: ([.messages[]? | select(.type=="gemini")] | length),
      info_count: ([.messages[]? | select(.type=="info")] | length),
      error_count: ([.messages[]? | select(.type=="error")] | length),
      tool_call_count: ([.messages[]?.toolCalls[]?] | length),
      models: ([.messages[]? | select(.type=="gemini") | .model // empty] | unique),
      first_user: ([.messages[]? | select(.type=="user") | text_content(.content)][0] // null)
    }
  ' "$f"
done > "$out"
```

Consultar índice:

```bash
jq -r '
  [
    .startTime,
    .sessionId,
    .dir,
    (.project_root // ""),
    (.models | join(",")),
    .message_count,
    .tool_call_count,
    (.first_user // "" | gsub("\n"; " ") | .[0:180]),
    .file
  ] | @tsv
' "$HOME/.gemini/tmp-analysis/gemini-sessions-index.jsonl" |
sort
```

## 22. Índice normalizado de mensagens

Gerar JSONL com mensagens normalizadas:

```bash
out="$HOME/.gemini/tmp-analysis/gemini-messages.jsonl"
mkdir -p "$(dirname "$out")"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
while IFS= read -r -d '' f; do
  jq -c --arg file "$f" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    . as $session |
    .messages[]? |
    {
      file: $file,
      projectHash: $session.projectHash,
      sessionId: $session.sessionId,
      sessionStartTime: $session.startTime,
      timestamp: .timestamp,
      id: .id,
      type: .type,
      model: (.model // null),
      text: text_content(.content),
      tool_call_count: ([.toolCalls[]?] | length),
      token_total: (.tokens.total // null)
    }
  ' "$f"
done > "$out"
```

Pesquisar no índice:

```bash
jq -r --arg q "termo de busca" '
  select(.text | test($q; "i")) |
  [
    .timestamp,
    .type,
    (.model // ""),
    .sessionId,
    .file,
    (.text | gsub("\n"; " ") | .[0:240])
  ] | @tsv
' "$HOME/.gemini/tmp-analysis/gemini-messages.jsonl"
```

## 23. Cuidados práticos

- `~/.gemini/tmp` contém prompts, respostas, código, comandos shell, diffs,
  paths locais e possíveis dados sensíveis.
- `toolCalls[].args.content`, `toolCalls[].result`, `resultDisplay.newContent`
  e `resultDisplay.originalContent` podem conter arquivos inteiros ou trechos
  grandes.
- `logs.json` tem apenas entradas de usuário, mas pode conter material sensível
  em `message`.
- `chats/session-*.json` é o melhor ponto de recuperação de conversas completas.
- `logs.json` pode conter sessões sem chat correspondente.
- Use `rg` para localização rápida e `jq` para extração controlada.

## 24. Receita curta

Encontrar sessões que mencionam um termo:

```bash
rg -l -i "termo" ~/.gemini/tmp
```

Pesquisar só em mensagens:

```bash
q="termo"

find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r --arg q "$q" '
    def text_content($c):
      if ($c|type) == "array" then
        [$c[]? | .text? // empty] | join("\n")
      elif ($c|type) == "string" then
        $c
      else
        ""
      end;

    .messages[]? |
    {file:input_filename, ts:.timestamp, type:.type, text:text_content(.content)} |
    select(.text | test($q; "i")) |
    [.ts, .type, .file, (.text | gsub("\n"; " ") | .[0:180])] | @tsv
  '
```

Abrir uma sessão como Markdown:

```bash
f="/ABSOLUTE/PATH/session-....json"

jq -r '
  def text_content($c):
    if ($c|type) == "array" then
      [$c[]? | .text? // empty] | join("\n")
    elif ($c|type) == "string" then
      $c
    else
      ""
    end;

  .messages[]? |
  "## " + (.type | ascii_upcase) + "\n\n" + text_content(.content) + "\n"
' "$f"
```

Listar chamadas de ferramenta:

```bash
find ~/.gemini/tmp -path '*/chats/session-*.json' -print0 |
  xargs -0 jq -r '
    .messages[]? |
    .toolCalls[]? |
    [
      input_filename,
      .timestamp,
      .name,
      (.status // ""),
      (.args.file_path // .args.dir_path // .args.directory // .args.query // "")
    ] | @tsv
  '
```

## 25. Conclusão

Para recuperar e pesquisar dados do Gemini CLI em `~/.gemini/tmp`, os arquivos
mais importantes são:

```text
<project>/chats/session-*.json
<project>/logs.json
<project>/.project_root
```

O caminho mais confiável é:

1. Usar `.project_root` quando existir para mapear o diretório ao projeto real.
2. Usar `projectHash` para identificar o projeto internamente.
3. Usar `sessionId` como identidade lógica da sessão.
4. Usar `messages[]` para reconstruir a conversa.
5. Usar `toolCalls[]` para auditar comandos, buscas, leituras, escritas e diffs.
6. Usar `logs.json` como índice auxiliar de prompts do usuário, especialmente
   para sessões que não têm arquivo de chat correspondente.

Comparado ao armazenamento do Codex, este diretório é menor e usa JSON comum em
vez de JSONL. A estrutura é mais simples, mas exige cuidado com duplicatas de
`sessionId`, diretórios nomeados que não batem com `projectHash`, e resultados
de ferramentas embutidos diretamente no JSON.
