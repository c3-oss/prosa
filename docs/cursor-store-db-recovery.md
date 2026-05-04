# Como ler os `store.db` do Cursor Agent

Data da investigação: 2026-05-03

Este documento descreve o processo usado para entender e recuperar dados dos arquivos
`store.db` em:

```text
~/.cursor/chats/
```

O objetivo foi descobrir:

- se os arquivos `store.db` são SQLite;
- qual schema eles usam;
- o que existe em `meta`;
- o que existe em `blobs`;
- como decodificar os blobs em JSON, texto e protobuf bruto;
- como recuperar mensagens `system`;
- como gerar arquivos separados a partir das mensagens recuperadas.

Este documento evita depender do conteúdo específico das conversas. Os comandos
mostram a técnica e os formatos.

## Resumo

Os arquivos encontrados seguem este padrão:

```text
~/.cursor/chats/<workspace-id>/<agent-id>/store.db
```

No ambiente analisado havia:

```text
648 arquivos store.db
54 diretórios de primeiro nível em ~/.cursor/chats
648 subdiretórios de sessão/agente
658 MB em arquivos store.db
679 MB no total incluindo store.db-wal, store.db-shm e .DS_Store
```

Todos os `store.db` eram bancos SQLite 3.x válidos.

Todos tinham o mesmo schema:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

A interpretação prática é:

- `meta` guarda metadados da sessão/agente.
- `blobs` é um object store endereçado por hash.
- O `meta.latestRootBlobId` aponta para o blob raiz mais recente.
- Os blobs podem ser JSON, texto puro, protobuf/estado binário, ou fragmentos de conteúdo.
- Mensagens de chat aparecem como JSON com `role`, por exemplo `system`, `user`, `assistant`, `tool`.

Janela temporal observada em `meta.createdAt`:

```text
2025-11-06T03:20:16Z até 2026-04-29T18:54:49Z
```

Arquivos encontrados sob `~/.cursor/chats`:

```text
648 store.db
648 store.db-wal
648 store.db-shm
36  .DS_Store
```

## Estrutura de diretórios

Formato geral:

```text
~/.cursor/chats/
  <workspace-id>/
    <agent-id>/
      store.db
      store.db-wal
      store.db-shm
```

Onde:

- `<workspace-id>` é um identificador opaco do workspace/projeto para o Cursor.
- `<agent-id>` é um UUID e bate com `meta.agentId`.
- `store.db` é o banco SQLite principal.
- `store.db-wal` é o write-ahead log do SQLite.
- `store.db-shm` é o arquivo auxiliar de shared memory do WAL.

No conjunto analisado:

```text
54 workspace-id
648 agent-id
648 store.db
648 pares store.db-wal/store.db-shm
```

O caminho do banco é suficiente para recuperar dois identificadores de navegação:

```bash
db="$HOME/.cursor/chats/<workspace-id>/<agent-id>/store.db"
workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
agent_id="$(basename "$(dirname "$db")")"
```

Verificar se `agent_id` do caminho bate com `meta.agentId`:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  agent_dir="$(basename "$(dirname "$db")")"
  meta_agent="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    while IFS= read -r hex; do
      printf '%s' "$hex" | xxd -r -p 2>/dev/null
    done |
    jq -r '.agentId // empty' 2>/dev/null
  )"

  if [ "$agent_dir" = "$meta_agent" ]; then
    echo match
  else
    echo mismatch
  fi
done |
sort |
uniq -c
```

Resultado observado:

```text
648 match
```

## Arquivos principais

### `store.db`

É o banco SQLite que contém as tabelas `meta` e `blobs`.

Tamanho observado dos `store.db`:

```text
648 arquivos
621735936 bytes
20 KiB mínimo
93724672 bytes máximo
959469 bytes em média
658 MB por du -ch
```

Comando:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print |
while read -r f; do
  wc -c < "$f"
done |
awk '
  BEGIN { min=-1 }
  {
    n++;
    s += $1;
    if (min < 0 || $1 < min) min=$1;
    if ($1 > max) max=$1
  }
  END {
    print "count", n;
    print "bytes", s;
    print "min", min;
    print "max", max;
    print "avg", int(s/n)
  }'
```

### `store.db-wal` e `store.db-shm`

Todos os bancos tinham arquivos WAL/SHM correspondentes no momento da análise.
Isso indica que o SQLite está usando WAL mode ou deixou arquivos auxiliares do
modo WAL.

Tamanho total observado:

```text
20 MB em store.db-wal e store.db-shm
```

Para uma leitura forense mais consistente, há duas opções:

1. Fechar o Cursor antes da coleta.
2. Copiar o trio `store.db`, `store.db-wal`, `store.db-shm` junto.

`immutable=1` é útil para inspeção sem lock, mas pode ignorar conteúdo recente
que ainda esteja no WAL. Para recuperar o estado mais novo, não trate o
`store.db` isolado como snapshot perfeito enquanto o Cursor estiver aberto.

### `.DS_Store`

Foram encontrados arquivos `.DS_Store` em alguns diretórios de workspace. Eles
são metadados do Finder/macOS e não fazem parte do formato do Cursor.

## 1. Descoberta inicial

Contar bancos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print | wc -l
```

Ver exemplos:

```bash
find ~/.cursor/chats -maxdepth 3 -type f -name 'store.db' -print | head -20
```

Ver tamanho total:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
  xargs -0 du -ch 2>/dev/null |
  tail -1
```

Confirmar tipo dos arquivos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
  xargs -0 file |
  head -30
```

Resultado esperado:

```text
SQLite 3.x database
```

Para contar todos por tipo:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  file -b "$db" | sed 's/,.*//'
done |
sort |
uniq -c
```

No ambiente analisado:

```text
648 SQLite 3.x database
```

## 2. Abrir SQLite sem alterar nada

Como o Cursor pode estar aberto e mantendo alguns bancos em uso, o jeito mais
prático foi usar URI SQLite em modo somente leitura e imutável:

```bash
sqlite3 "file:/ABSOLUTE/PATH/store.db?mode=ro&immutable=1" ".schema"
```

Onde:

- `mode=ro` abre em somente leitura.
- `immutable=1` evita locks e diz ao SQLite para tratar o arquivo como imutável.

Observação importante: `immutable=1` é ótimo para inspeção forense/local, mas ele
pode ignorar mudanças ainda não checkpointadas em WAL se o banco estiver sendo
escrito naquele exato momento. Para uma fotografia mais consistente, feche o
Cursor ou faça uma cópia antes.

Exemplo com variável:

```bash
db="$HOME/.cursor/chats/<workspace-id>/<agent-id>/store.db"
sqlite3 "file:$db?mode=ro&immutable=1" ".tables"
sqlite3 "file:$db?mode=ro&immutable=1" ".schema"
sqlite3 "file:$db?mode=ro&immutable=1" "PRAGMA quick_check;"
```

Verificar todos:

```bash
root="$HOME"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" "PRAGMA quick_check;" 2>/dev/null ||
    echo "ERR $db"
done |
sort |
uniq -c
```

No ambiente analisado:

```text
648 ok
```

## 3. Schema

O schema é pequeno:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

Ver schema de um banco:

```bash
db="$HOME/.cursor/chats/<workspace-id>/<agent-id>/store.db"
sqlite3 "file:$db?mode=ro&immutable=1" ".schema"
```

Contar linhas:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT 'meta', count(*) FROM meta UNION ALL SELECT 'blobs', count(*) FROM blobs;"
```

No conjunto inteiro, foi encontrado:

```text
648 bancos
648 linhas em meta, uma por banco
71172 linhas em blobs
```

## 4. Estrutura de `meta`

Cada banco tinha uma linha em `meta`, com `key = '0'`.

Inspecionar tipos:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT key, typeof(key), typeof(value), length(value), substr(value,1,80) FROM meta;"
```

Ponto importante: `meta.value` é declarado como `TEXT`, mas o texto armazenado é
um JSON codificado como hexadecimal.

Ou seja, o valor parece assim:

```text
7b226167656e744964223a...
```

Para decodificar:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT value FROM meta WHERE key='0';" |
  xxd -r -p |
  jq .
```

Formato típico:

```json
{
  "agentId": "64a9033f-00d4-4870-af5a-d2331bde2876",
  "latestRootBlobId": "62e17c13413abbc6bb5cfe8962da1428f6dcbb7c460422ca569890d4a3a83999",
  "name": "New Agent",
  "mode": "default",
  "createdAt": 1774457736671
}
```

Campos observados:

```text
648 agentId
648 latestRootBlobId
648 name
648 mode
648 createdAt
172 lastUsedModel
46  isRunEverything
16  currentPlanUri
```

Contar campos em `meta`:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -r 'keys[]' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Notas:

- `agentId` bate com o diretório `<agent-id>`.
- `createdAt` é timestamp Unix em milissegundos.
- `latestRootBlobId` aponta para um registro em `blobs.id`.
- `mode` indicava modos como `default`, `auto-run`, `plan` e `search`.
- `lastUsedModel`, quando existe, indica o modelo usado naquela sessão.

Contagem de `mode`:

```text
403 default
233 auto-run
11  plan
1   search
```

Contagem de `lastUsedModel`:

```text
476 ausente
43  grok-code-fast-1
33  composer-2-fast
32  composer-1
26  composer-1.5
7   composer-2
7   claude-4.6-opus-max-thinking
7   claude-4.5-opus-high-thinking
6   claude-4.6-opus-high-thinking
3   claude-4.5-sonnet-thinking
2   gemini-3.1-pro
1   gpt-5.5
1   gpt-5-codex-high
1   gemini-3-pro
1   claude-opus-4-7-thinking-high
1   claude-opus-4-7
1   claude-4.6-opus-high
```

Checar modos:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -r '.mode // "__missing__"' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Checar modelos:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -r '.lastUsedModel // "__missing__"' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Converter `createdAt` para data:

```bash
node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' 1774457736671
```

Janela temporal observada:

```text
min createdAt: 1762399216186 -> 2025-11-06T03:20:16Z
max createdAt: 1777488889484 -> 2026-04-29T18:54:49Z
```

Calcular a janela:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -rs '
  [.[].createdAt] |
  {
    count: length,
    min_ms: min,
    max_ms: max,
    min_iso: ((min / 1000) | todateiso8601),
    max_iso: ((max / 1000) | todateiso8601)
  }'
```

Checar se `latestRootBlobId` existe em `blobs`:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  root="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    while IFS= read -r hex; do
      printf '%s' "$hex" | xxd -r -p 2>/dev/null
    done |
    jq -r '.latestRootBlobId // empty' 2>/dev/null
  )"

  if [ -z "$root" ]; then
    echo missing
    continue
  fi

  found="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT count(*) FROM blobs WHERE id='$root';" 2>/dev/null
  )"

  if [ "$found" = 1 ]; then
    echo found
  else
    echo not_found
  fi
done |
sort |
uniq -c
```

Resultado observado:

```text
647 found
1   missing
```

O caso `missing` era uma sessão com `latestRootBlobId` vazio, não um ponteiro
quebrado para um blob inexistente.

## 5. Estrutura de `blobs`

A tabela:

```sql
CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
```

O campo `id` aparenta ser hash hexadecimal de 64 caracteres, compatível com
SHA-256, embora a investigação não tenha confirmado formalmente se o hash é
exatamente `sha256(data)`.

Inspecionar os maiores blobs:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT id, length(data), hex(substr(data,1,16))
   FROM blobs
   ORDER BY length(data) DESC
   LIMIT 20;"
```

Classificar por primeiro byte:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT
     CASE
       WHEN length(data)=0 THEN 'empty'
       WHEN hex(substr(data,1,1))='7B' THEN 'json-object'
       WHEN hex(substr(data,1,1))='5B' THEN 'json-array'
       WHEN hex(substr(data,1,1))='0A' THEN 'protobuf-ish-0A'
       WHEN hex(substr(data,1,1))='12' THEN 'protobuf-ish-12'
       WHEN hex(substr(data,1,1))='1A' THEN 'protobuf-ish-1A'
       WHEN hex(substr(data,1,1)) BETWEEN '20' AND '7E' THEN 'plain-text-ish'
       ELSE 'other-binary-' || hex(substr(data,1,1))
     END,
     count(*),
     sum(length(data)),
     max(length(data))
   FROM blobs
   GROUP BY 1
   ORDER BY count(*) DESC;"
```

No conjunto completo, a classificação aproximada foi:

```text
49417 protobuf-ish   262 MB
19676 json-prefix    284 MB
2068  plain text-ish  18 MB
11    empty            0 B
```

Entre os blobs com prefixo JSON:

```text
19633 valid-json-object-prefix
43    invalid-json-prefix
0     valid-json-array-prefix
```

Contagem de blobs por banco:

```text
648 bancos
71172 linhas em blobs
1 blob mínimo por banco
3945 blobs máximo por banco
109 blobs em média por banco
```

Comando para recalcular:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT count(*) FROM blobs;" 2>/dev/null
done |
awk '
  BEGIN { min=-1 }
  {
    n++;
    s += $1;
    if (min < 0 || $1 < min) min=$1;
    if ($1 > max) max=$1
  }
  END {
    print "dbs", n;
    print "blob_rows", s;
    print "min", min;
    print "max", max;
    print "avg", int(s/n)
  }'
```

Interpretação:

- Bytes iniciais `7B` e `5B` são `{` e `[`, portanto JSON.
- Bytes iniciais `0A`, `12`, `1A` são comuns em protobuf, indicando campos
  length-delimited.
- Bytes imprimíveis como `23`, `2D`, `3C`, `66`, `69` indicam texto bruto:
  Markdown, diff, código, XML/HTML, caminhos, logs etc.
- Prefixo JSON não garante JSON válido. No conjunto analisado havia 43 blobs
  começando com `{` ou `[` que não passavam em `json_valid`.

Contar validade dos prefixos JSON:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT
       CASE
         WHEN hex(substr(data,1,1))='7B'
           AND json_valid(CAST(data AS TEXT))
           THEN 'valid-json-object-prefix'
         WHEN hex(substr(data,1,1))='5B'
           AND json_valid(CAST(data AS TEXT))
           THEN 'valid-json-array-prefix'
         WHEN hex(substr(data,1,1)) IN ('7B','5B')
           THEN 'invalid-json-prefix'
         ELSE 'not-json-prefix'
       END,
       count(*)
     FROM blobs
     GROUP BY 1;" 2>/dev/null
done |
awk -F'|' '{c[$1]+=$2} END{for(k in c) print c[k], k}' |
sort -nr
```

## 6. Ler blobs JSON

Para blobs que começam com `{` e são JSON válido:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT
     id,
     length(data),
     json_extract(CAST(data AS TEXT), '$.role'),
     substr(CAST(data AS TEXT), 1, 200)
   FROM blobs
   WHERE hex(substr(data,1,1))='7B'
     AND json_valid(CAST(data AS TEXT))
   LIMIT 20;"
```

Contar mensagens JSON por `role` em todos os bancos:

```bash
root="$HOME"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT
       coalesce(json_extract(CAST(data AS TEXT),'$.role'),'__no_role__'),
       count(*)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
     GROUP BY 1;" 2>/dev/null
done |
awk -F'|' '{c[$1]+=$2} END{for(k in c) print c[k], k}' |
sort -nr
```

No ambiente analisado:

```text
10012 tool
7271  assistant
1651  user
659   system
40    __no_role__
```

Exemplo de formato de mensagem JSON:

```json
{
  "role": "system",
  "content": "You are an AI coding assistant..."
}
```

Algumas mensagens têm `content` como string; outras usam array de partes.

### Campos de mensagens JSON

Entre blobs JSON válidos que tinham `role`, os campos de topo mais comuns foram:

```text
19593 role
19593 content
17278 id
9897  providerOptions
```

Contar campos de mensagens:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role') IS NOT NULL;" 2>/dev/null
done |
jq -r 'keys[]' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Campos por `role`:

```text
assistant:
  7271 role
  7271 id
  7271 content
  37   providerOptions

tool:
  10012 role
  10012 content
  10007 id
  8975  providerOptions

user:
  1651 role
  1651 content
  885  providerOptions

system:
  659 role
  659 content
```

### Tipo de `content` por `role`

```text
10012 tool       array
7271  assistant  array
980   user       array
671   user       string
659   system     string
```

Comando:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role') IS NOT NULL;" 2>/dev/null
done |
jq -r '[.role, (.content|type)] | @tsv' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

### Blocos de conteúdo

Quando `content` é array, ele contém blocos tipados. Os tipos observados foram:

```text
10314 assistant  tool-call
10012 tool       tool-result
4367  assistant  text
3138  assistant  reasoning
1176  assistant  redacted-reasoning
1152  user       text
```

Comando:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role') IS NOT NULL;" 2>/dev/null
done |
jq -r '
  select(.content|type=="array") |
  .role as $role |
  .content[]? |
  [$role, (.type // "__no_type__")] |
  @tsv
' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Campos mais comuns em blocos de conteúdo:

```text
30159 type
20326 toolName
20326 toolCallId
10314 args
10012 result
9991  experimental_content
8657  text
4234  providerOptions
1176  data
970   signature
```

### `system`

Mensagens `system` têm formato simples:

```json
{
  "role": "system",
  "content": "..."
}
```

No conjunto analisado:

```text
659 system messages
659 content string
```

Essas mensagens são o alvo das rotinas de recuperação documentadas nas seções
9, 10 e 11.

### `user`

Mensagens de usuário podem ter `content` como string:

```json
{
  "role": "user",
  "content": "..."
}
```

Ou como array:

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "..."
    }
  ],
  "providerOptions": {}
}
```

No conjunto analisado:

```text
671 user content string
980 user content array
1152 blocos user/text
885 user com providerOptions
```

Extrair prompts de usuário sem expor ferramentas:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='user';" 2>/dev/null |
  jq -r --arg db "$db" '
    . as $msg |
    if ($msg.content|type) == "string" then
      [$db, $msg.id, $msg.content] | @tsv
    else
      $msg.content[]? |
      select(.type=="text") |
      [$db, $msg.id, .text] | @tsv
    end
  ' 2>/dev/null
done
```

### `assistant`

Mensagens do assistente têm `content` como array:

```json
{
  "role": "assistant",
  "id": "...",
  "content": [
    {
      "type": "text",
      "text": "..."
    },
    {
      "type": "tool-call",
      "toolCallId": "...",
      "toolName": "Read",
      "args": {}
    }
  ]
}
```

Campos observados:

```text
7271 role
7271 id
7271 content
37   providerOptions
```

Blocos do assistente:

```text
10314 tool-call
4367  text
3138  reasoning
1176  redacted-reasoning
```

Bloco `text`:

```json
{
  "type": "text",
  "text": "..."
}
```

Bloco `reasoning`:

```json
{
  "type": "reasoning",
  "text": "...",
  "signature": "...",
  "providerOptions": {}
}
```

Bloco `redacted-reasoning`:

```json
{
  "type": "redacted-reasoning",
  "data": "..."
}
```

Bloco `tool-call`:

```json
{
  "type": "tool-call",
  "toolCallId": "...",
  "toolName": "Shell",
  "args": {}
}
```

### `tool`

Mensagens de ferramenta também têm `content` como array:

```json
{
  "role": "tool",
  "id": "...",
  "content": [
    {
      "type": "tool-result",
      "toolCallId": "...",
      "toolName": "Shell",
      "result": "...",
      "experimental_content": []
    }
  ],
  "providerOptions": {}
}
```

Campos observados:

```text
10012 role
10012 content
10007 id
8975  providerOptions
```

O relacionamento principal é:

```text
assistant.content[].toolCallId == tool.content[].toolCallId
```

Ou seja, o `tool-call` do assistente e o `tool-result` posterior se ligam por
`toolCallId`.

### Ferramentas

Ferramentas mais frequentes em `assistant.content[].toolName`:

```text
2641 Read
1986 Shell
1798 StrReplace
814  Grep
567  TodoWrite
406  Glob
375  run_terminal_cmd
321  read_file
308  Write
173  search_replace
150  LS
110  playwright-browser_navigate
88   grep
55   glob_file_search
49   ApplyPatch
48   codebase_search
42   ReadFile
40   playwright-browser_take_screenshot
38   CreatePlan
34   todo_write
```

Ferramentas mais frequentes em `tool.content[].toolName`:

```text
2592 Read
1827 Shell
1771 StrReplace
803  Grep
548  TodoWrite
398  Glob
374  run_terminal_cmd
321  read_file
302  Write
173  search_replace
144  LS
89   playwright-browser_navigate
88   grep
65   playwright-browser_take_screenshot
55   glob_file_search
49   ApplyPatch
48   codebase_search
42   ReadFile
38   CreatePlan
34   todo_write
```

Contar `tool-call`:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='assistant';" 2>/dev/null
done |
jq -r '
  .content[]? |
  select(.type=="tool-call") |
  .toolName // "__missing__"
' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

Contar `tool-result`:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='tool';" 2>/dev/null
done |
jq -r '
  .content[]? |
  select(.type=="tool-result") |
  .toolName // "__missing__"
' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

### `providerOptions`

`providerOptions` aparece principalmente em mensagens `tool` e `user`.

Contagem:

```text
9897 providerOptions object
9897 providerOptions.cursor
```

Campos observados em `providerOptions.cursor`:

```text
8975 highLevelToolCallResult
870  requestId
32   openaiPhase
32   modelProviderMessageId
13   isSummary
5    pendingToolCallStartedAtMs
2    loopReminder
```

`highLevelToolCallResult` tinha:

```text
8975 output
8299 isError
111  rawErrorMessages
```

Tipos observados:

```text
8970 highLevelToolCallResult.output object
5    highLevelToolCallResult.output array
8299 highLevelToolCallResult.isError boolean
111  highLevelToolCallResult.rawErrorMessages array
```

Isso indica que o resultado legível da ferramenta pode estar duplicado ou
normalizado em:

1. `content[].result`
2. `content[].experimental_content`
3. `providerOptions.cursor.highLevelToolCallResult`

Para reconstrução fiel de ferramentas, leia os três.

### JSON sem `role`

Foram encontrados `40` blobs JSON válidos sem `role`.

Eles não parecem mensagens de chat. Podem ser conteúdo de arquivos JSON lidos
pelo agente, configuração, relatórios estruturados ou fragmentos de ferramenta.

Para listar apenas os blobs JSON sem `role` sem imprimir conteúdo:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, length(data)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role') IS NULL;" 2>/dev/null |
  while IFS='|' read -r id bytes; do
    [ -n "$id" ] || continue
    printf '%s\t%s\t%s\n' "$db" "$id" "$bytes"
  done
done
```

## 7. Seguir o `latestRootBlobId`

O `meta` aponta para o blob raiz:

```bash
root_blob_id="$(
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" |
    xxd -r -p |
    jq -r '.latestRootBlobId'
)"
```

No conjunto analisado:

```text
648 bancos
647 latestRootBlobId não vazio e encontrado em blobs
1 latestRootBlobId vazio
643 root blobs começando com 0A, compatíveis com protobuf
4 root blobs vazios
1109249 bytes somados em root blobs
0 bytes mínimo
35289 bytes máximo
1714 bytes em média
```

Contar classes dos root blobs:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  root="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    while IFS= read -r hex; do
      printf '%s' "$hex" | xxd -r -p 2>/dev/null
    done |
    jq -r '.latestRootBlobId // empty' 2>/dev/null
  )"

  if [ -z "$root" ]; then
    echo 'missing|0|0'
    continue
  fi

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT
       CASE
         WHEN length(data)=0 THEN 'empty'
         WHEN hex(substr(data,1,1)) IN ('7B','5B') THEN 'json-prefix'
         WHEN hex(substr(data,1,1)) IN ('0A','12','1A') THEN 'protobuf-ish'
         WHEN hex(substr(data,1,1)) BETWEEN '20' AND '7E' THEN 'plain-text-ish'
         ELSE 'other-' || hex(substr(data,1,1))
       END,
       length(data),
       hex(substr(data,1,1))
     FROM blobs
     WHERE id='$root';" 2>/dev/null
done |
awk -F'|' '
  {
    c[$1]++;
    s[$1] += $2;
    if ($2 > m[$1]) m[$1]=$2
  }
  END { for (k in c) print c[k], s[k], m[k], k }
' |
sort -nr
```

Extrair esse blob para arquivo:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT hex(data) FROM blobs WHERE id='$root_blob_id';" |
  xxd -r -p > /tmp/cursor-root-blob.bin
```

Tentar decodificar como protobuf bruto:

```bash
protoc --decode_raw < /tmp/cursor-root-blob.bin
```

Isso funciona mesmo sem o arquivo `.proto`, porque `--decode_raw` mostra apenas
números de campos e valores.

Exemplo de saída observada:

```text
1: "<blob-id-ou-bytes>"
1: "<blob-id-ou-bytes>"
5 {
  1: 12315
  2: 200000
}
9: "file:///Users/upsetbit/Projects/..."
10: 1
21 {
  1: "/Users/upsetbit/Projects/..."
  2: "dev"
}
```

Interpretação:

- Campos `1` repetidos frequentemente são referências para outros blobs ou IDs
  binários.
- Campo `9` apareceu como `workspaceUri`.
- Campo `21` apareceu com path local e branch Git.
- Outros campos guardam estado do agente, contadores, limites, árvore de
  mensagens e referências internas.

Sem o `.proto`, os nomes de campos não são conhecidos. Ainda assim, o
`--decode_raw` é suficiente para provar que os blobs binários principais usam
protobuf ou formato wire-compatible com protobuf.

## 8. Plain text e conteúdo bruto

Nem todo blob é JSON ou protobuf. Alguns blobs começam diretamente com texto.

Exemplos de prefixos:

```text
23  '#', comum em Markdown
2D  '-', comum em frontmatter YAML ou diff
3C  '<', comum em XML/HTML
66  'f'
69  'i'
75  'u'
```

Para ver exemplos sem despejar tudo:

```bash
sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT
     id,
     length(data),
     hex(substr(data,1,1)),
     replace(substr(CAST(data AS TEXT),1,120), char(10), '\\n')
   FROM blobs
   WHERE hex(substr(data,1,1)) NOT IN ('7B','5B','0A','12','1A')
   LIMIT 20;"
```

Esses blobs podem conter:

- conteúdo de arquivos lidos pelo agente;
- diffs;
- relatórios Markdown;
- código-fonte;
- saídas de ferramentas;
- logs;
- snippets passados como contexto.

## 9. Recuperar mensagens `system`

O critério usado foi:

- blob começa com `{`;
- blob é JSON válido;
- `$.role == "system"`.

O script abaixo gera um JSONL bruto com todas as mensagens `system`.

Arquivo de saída:

```text
~/.cursor/recovered-system-messages.jsonl
```

Script:

```bash
set -euo pipefail

out="$HOME/.cursor/recovered-system-messages.jsonl"
tmp="$out.tmp"
rm -f "$tmp"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  meta_hex="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null || true
  )"

  [ -n "$meta_hex" ] || continue

  meta_json="$(printf '%s' "$meta_hex" | xxd -r -p 2>/dev/null || true)"
  created_at="$(printf '%s' "$meta_json" | jq -r '.createdAt // null' 2>/dev/null || echo null)"
  name="$(printf '%s' "$meta_json" | jq -r '.name // null' 2>/dev/null || echo null)"
  mode="$(printf '%s' "$meta_json" | jq -r '.mode // null' 2>/dev/null || echo null)"
  model="$(printf '%s' "$meta_json" | jq -r '.lastUsedModel // null' 2>/dev/null || echo null)"

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, hex(data)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='system';" 2>/dev/null |
  while IFS='|' read -r blob_id data_hex; do
    [ -n "$blob_id" ] || continue

    message_json="$(printf '%s' "$data_hex" | xxd -r -p)"

    printf '%s' "$message_json" |
    jq -c \
      --arg db "$db" \
      --arg workspace_id "$workspace_id" \
      --arg agent_id "$agent_id" \
      --arg blob_id "$blob_id" \
      --argjson created_at "$created_at" \
      --arg name "$name" \
      --arg mode "$mode" \
      --arg model "$model" \
      '{
        db: $db,
        workspaceId: $workspace_id,
        agentId: $agent_id,
        blobId: $blob_id,
        createdAt: $created_at,
        name: $name,
        mode: $mode,
        model: $model,
        message: .
      }' >> "$tmp"
  done
done

mv "$tmp" "$out"
wc -l "$out"
ls -lh "$out"
```

Resultado observado:

```text
659 ~/.cursor/recovered-system-messages.jsonl
5.3M
```

## 10. Deduplicar mensagens `system`

Como várias sessões usam o mesmo system prompt, o arquivo bruto pode ser
deduplicado por conteúdo.

Arquivo de saída:

```text
~/.cursor/recovered-system-messages.unique.jsonl
```

Script:

```bash
node <<'NODE'
const fs = require('fs');
const crypto = require('crypto');

const input = `${process.env.HOME}/.cursor/recovered-system-messages.jsonl`;
const output = `${process.env.HOME}/.cursor/recovered-system-messages.unique.jsonl`;

const lines = fs.readFileSync(input, 'utf8').split(/\n/).filter(Boolean);
const map = new Map();

for (const line of lines) {
  const rec = JSON.parse(line);
  const key = JSON.stringify(rec.message);
  const hash = crypto.createHash('sha256').update(key).digest('hex');

  let entry = map.get(hash);
  if (!entry) {
    entry = {
      hash,
      count: 0,
      firstSeen: rec.createdAt,
      lastSeen: rec.createdAt,
      example: rec,
      sources: []
    };
    map.set(hash, entry);
  }

  entry.count++;

  if (typeof rec.createdAt === 'number') {
    if (entry.firstSeen == null || rec.createdAt < entry.firstSeen) {
      entry.firstSeen = rec.createdAt;
    }
    if (entry.lastSeen == null || rec.createdAt > entry.lastSeen) {
      entry.lastSeen = rec.createdAt;
    }
  }

  if (entry.sources.length < 20) {
    entry.sources.push({
      db: rec.db,
      blobId: rec.blobId,
      name: rec.name,
      mode: rec.mode,
      model: rec.model,
      createdAt: rec.createdAt
    });
  }
}

const entries = [...map.values()].sort(
  (a, b) => b.count - a.count || String(a.hash).localeCompare(String(b.hash))
);

fs.writeFileSync(output, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

console.log('raw', lines.length);
console.log('unique', entries.length);
console.log('output', output);
NODE
```

Resultado observado:

```text
raw 659
unique 42
```

## 11. Gerar um arquivo por system prompt

Entrada:

```text
~/.cursor/recovered-system-messages.unique.jsonl
```

Saída:

```text
~/.cursor/recovered-system-messages.unique/
```

Script:

```bash
node <<'NODE'
const fs = require('fs');
const path = require('path');

const input = `${process.env.HOME}/.cursor/recovered-system-messages.unique.jsonl`;
const outDir = `${process.env.HOME}/.cursor/recovered-system-messages.unique`;

fs.mkdirSync(outDir, { recursive: true });

for (const name of fs.readdirSync(outDir)) {
  if (/^system-\d{2}-[a-f0-9]{12}\.(md|json)$/.test(name) || name === 'index.json') {
    fs.rmSync(path.join(outDir, name));
  }
}

const lines = fs.readFileSync(input, 'utf8').split(/\n/).filter(Boolean);
const entries = lines.map(line => JSON.parse(line));
const index = [];

entries.forEach((entry, i) => {
  const n = String(i + 1).padStart(2, '0');
  const short = entry.hash.slice(0, 12);
  const base = `system-${n}-${short}`;
  const mdFile = `${base}.md`;
  const jsonFile = `${base}.json`;

  const content = entry.example?.message?.content;
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

  const firstSeen = typeof entry.firstSeen === 'number'
    ? new Date(entry.firstSeen).toISOString()
    : null;

  const lastSeen = typeof entry.lastSeen === 'number'
    ? new Date(entry.lastSeen).toISOString()
    : null;

  const frontmatter = [
    '---',
    'type: cursor-system-message',
    `hash: ${entry.hash}`,
    `count: ${entry.count}`,
    `firstSeen: ${firstSeen ?? ''}`,
    `lastSeen: ${lastSeen ?? ''}`,
    `source: ${input}`,
    '---',
    ''
  ].join('\n');

  fs.writeFileSync(path.join(outDir, mdFile), frontmatter + text + '\n');
  fs.writeFileSync(path.join(outDir, jsonFile), JSON.stringify(entry, null, 2) + '\n');

  index.push({
    order: i + 1,
    hash: entry.hash,
    count: entry.count,
    firstSeen,
    lastSeen,
    mdFile,
    jsonFile,
    sampleName: entry.example?.name ?? null,
    sampleMode: entry.example?.mode ?? null,
    sampleModel: entry.example?.model ?? null,
    sampleDb: entry.example?.db ?? null,
    sourceCountStored: entry.sources?.length ?? 0
  });
});

fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

console.log(outDir);
console.log('md', fs.readdirSync(outDir).filter(f => f.endsWith('.md')).length);
console.log('json', fs.readdirSync(outDir).filter(f => /^system-.*\.json$/.test(f)).length);
NODE
```

Resultado observado:

```text
42 arquivos .md
42 arquivos .json
1 index.json
```

## 12. Listagens úteis

Ver índice resumido das mensagens únicas:

```bash
jq -r '[.count, .hash, (.example.message.content | tostring | gsub("\n"; " ") | .[0:120])] | @tsv' \
  ~/.cursor/recovered-system-messages.unique.jsonl
```

Abrir todos os system prompts únicos:

```bash
jq -r '.example.message.content' \
  ~/.cursor/recovered-system-messages.unique.jsonl |
  less
```

Listar arquivos gerados:

```bash
find ~/.cursor/recovered-system-messages.unique -maxdepth 1 -type f | sort
```

Ver uma mensagem específica:

```bash
less ~/.cursor/recovered-system-messages.unique/system-01-a2f3b8e40f19.md
```

Ver metadados de uma mensagem específica:

```bash
jq . ~/.cursor/recovered-system-messages.unique/system-01-a2f3b8e40f19.json
```

### Contar roles de mensagens

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT
       coalesce(json_extract(CAST(data AS TEXT),'$.role'),'__no_role__'),
       count(*)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
     GROUP BY 1;" 2>/dev/null
done |
awk -F'|' '{c[$1]+=$2} END{for(k in c) print c[k], k}' |
sort -nr
```

### Buscar texto em mensagens JSON

```bash
term="texto a buscar"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT));" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    [ -n "$blob_id" ] || continue

    printf '%s' "$json" |
    jq -r --arg term "$term" \
      --arg db "$db" \
      --arg workspace_id "$workspace_id" \
      --arg agent_id "$agent_id" \
      --arg blob_id "$blob_id" '
        tostring as $s |
        select($s | contains($term)) |
        [$db, $workspace_id, $agent_id, $blob_id, (.role // "__no_role__")] |
        @tsv
      ' 2>/dev/null
  done
done
```

### Buscar texto em blobs textuais

```bash
term="texto a buscar"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, replace(substr(CAST(data AS TEXT),1,1000), char(10), '\\n')
     FROM blobs
     WHERE length(data)>0
       AND hex(substr(data,1,1)) BETWEEN '20' AND '7E'
       AND instr(CAST(data AS TEXT), '$term') > 0;" 2>/dev/null |
  while IFS='|' read -r blob_id preview; do
    [ -n "$blob_id" ] || continue
    printf '%s\t%s\t%s\n' "$db" "$blob_id" "$preview"
  done
done
```

Observação: esse comando injeta `$term` dentro da query SQL. Para buscas
adversariais ou automatizadas, escape aspas simples ou faça a busca fora do
SQLite com `jq`, `rg` ou uma linguagem com binding SQLite parametrizado.

### Extrair todos os blobs JSON como JSONL

Arquivo de saída:

```text
~/.cursor/recovered-json-blobs.jsonl
```

Script:

```bash
set -euo pipefail

out="$HOME/.cursor/recovered-json-blobs.jsonl"
tmp="$out.tmp"
rm -f "$tmp"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, hex(data)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT));" 2>/dev/null |
  while IFS='|' read -r blob_id data_hex; do
    [ -n "$blob_id" ] || continue
    json="$(printf '%s' "$data_hex" | xxd -r -p)"

    printf '%s' "$json" |
    jq -c \
      --arg db "$db" \
      --arg workspace_id "$workspace_id" \
      --arg agent_id "$agent_id" \
      --arg blob_id "$blob_id" \
      '{
        db: $db,
        workspaceId: $workspace_id,
        agentId: $agent_id,
        blobId: $blob_id,
        role: (.role // null),
        data: .
      }' >> "$tmp"
  done
done

mv "$tmp" "$out"
wc -l "$out"
```

### Extrair timeline legível de uma sessão

```bash
db="$HOME/.cursor/chats/<workspace-id>/<agent-id>/store.db"

sqlite3 "file:$db?mode=ro&immutable=1" \
  "SELECT id, CAST(data AS TEXT)
   FROM blobs
   WHERE hex(substr(data,1,1))='7B'
     AND json_valid(CAST(data AS TEXT))
     AND json_extract(CAST(data AS TEXT),'$.role') IS NOT NULL;" |
while IFS='|' read -r blob_id json; do
  printf '%s' "$json" |
  jq -r --arg blob_id "$blob_id" '
    if .role == "system" then
      ["SYSTEM", $blob_id, (.content|tostring|length)] | @tsv
    elif .role == "user" then
      [
        "USER",
        $blob_id,
        (
          if (.content|type) == "string" then
            .content
          else
            ([.content[]? | select(.type=="text") | .text] | join("\n"))
          end
          | gsub("\n"; " ")
          | .[0:200]
        )
      ] | @tsv
    elif .role == "assistant" then
      [
        "ASSISTANT",
        $blob_id,
        ([.content[]? | select(.type=="text") | .text] | join("\n") | gsub("\n"; " ") | .[0:200])
      ] | @tsv
    elif .role == "tool" then
      [
        "TOOL",
        $blob_id,
        ([.content[]? | select(.type=="tool-result") | .toolName] | join(","))
      ] | @tsv
    else
      empty
    end
  '
done
```

Limitação: a query acima lista mensagens JSON encontradas nos blobs. A ordem
pode não representar perfeitamente a ordem da conversa, porque a ordem canônica
fica na árvore/estado protobuf. Ainda assim é útil para busca e triagem.

### Extrair textos do assistente

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='assistant';" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -r --arg db "$db" --arg blob_id "$blob_id" '
      .content[]? |
      select(.type=="text") |
      [$db, $blob_id, .text] |
      @tsv
    ' 2>/dev/null
  done
done
```

### Extrair chamadas de ferramenta

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='assistant';" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -r --arg db "$db" --arg blob_id "$blob_id" '
      .content[]? |
      select(.type=="tool-call") |
      [
        $db,
        $blob_id,
        .toolCallId,
        .toolName,
        (.args | tostring)
      ] |
      @tsv
    ' 2>/dev/null
  done
done
```

### Extrair resultados de ferramenta

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='tool';" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -r --arg db "$db" --arg blob_id "$blob_id" '
      .content[]? |
      select(.type=="tool-result") |
      [
        $db,
        $blob_id,
        .toolCallId,
        .toolName,
        (.result | type),
        (.experimental_content | type),
        (.result | tostring | length)
      ] |
      @tsv
    ' 2>/dev/null
  done
done
```

### Extrair resultados com erro

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role')='tool'
       AND json_extract(CAST(data AS TEXT),'$.providerOptions.cursor.highLevelToolCallResult.isError')=1;" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -r --arg db "$db" --arg blob_id "$blob_id" '
      [
        $db,
        $blob_id,
        (.content[]? | select(.type=="tool-result") | .toolCallId),
        (.content[]? | select(.type=="tool-result") | .toolName),
        (.providerOptions.cursor.highLevelToolCallResult.rawErrorMessages // [] | tostring)
      ] |
      @tsv
    ' 2>/dev/null
  done
done
```

### Relacionar `tool-call` e `tool-result`

Para um `toolCallId` específico:

```bash
tool_id="toolu_..."

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND instr(CAST(data AS TEXT), '$tool_id') > 0;" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -r --arg db "$db" --arg blob_id "$blob_id" --arg tool_id "$tool_id" '
      . as $msg |
      .content[]? |
      select(.toolCallId == $tool_id) |
      [$db, $blob_id, $msg.role, .type, .toolName] |
      @tsv
    ' 2>/dev/null
  done
done
```

Se adaptar esse comando, lembre que `tool_id` também é injetado no SQL.

### Agrupar por workspace

```bash
for d in "$HOME/.cursor/chats"/*; do
  [ -d "$d" ] || continue

  stores="$(find "$d" -mindepth 2 -maxdepth 2 -type f -name 'store.db' | wc -l | tr -d ' ')"
  blobs="$(
    find "$d" -mindepth 2 -maxdepth 2 -type f -name 'store.db' -print0 |
    while IFS= read -r -d '' db; do
      sqlite3 "file:$db?mode=ro&immutable=1" "SELECT count(*) FROM blobs;" 2>/dev/null
    done |
    awk '{s+=$1} END{print s+0}'
  )"
  size="$(du -sh "$d" | awk '{print $1}')"

  printf '%s\t%s\t%s\t%s\n' "$size" "$stores" "$blobs" "$(basename "$d")"
done |
sort -hr
```

### Agrupar por modo

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -r '.mode // "__missing__"' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

### Agrupar por modelo

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
  while IFS= read -r hex; do
    printf '%s' "$hex" | xxd -r -p 2>/dev/null
    printf '\n'
  done
done |
jq -r '.lastUsedModel // "__missing__"' 2>/dev/null |
sort |
uniq -c |
sort -nr
```

### Exportar blobs textuais

```bash
out="$HOME/.cursor/recovered-text-blobs"
mkdir -p "$out"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, hex(data)
     FROM blobs
     WHERE length(data)>0
       AND hex(substr(data,1,1)) BETWEEN '20' AND '7E';" 2>/dev/null |
  while IFS='|' read -r blob_id data_hex; do
    [ -n "$blob_id" ] || continue
    dir="$out/$workspace_id/$agent_id"
    mkdir -p "$dir"
    printf '%s' "$data_hex" | xxd -r -p > "$dir/$blob_id.txt"
  done
done
```

### Exportar root blobs

```bash
out="$HOME/.cursor/recovered-root-blobs"
mkdir -p "$out"

find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  root="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    while IFS= read -r hex; do
      printf '%s' "$hex" | xxd -r -p 2>/dev/null
    done |
    jq -r '.latestRootBlobId // empty' 2>/dev/null
  )"

  [ -n "$root" ] || continue

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT hex(data) FROM blobs WHERE id='$root';" 2>/dev/null |
  xxd -r -p > "$out/$workspace_id-$agent_id-root.bin"
done
```

Decodificar um root exportado:

```bash
protoc --decode_raw < "$HOME/.cursor/recovered-root-blobs/<file>.bin"
```

## 13. Mapa mental do formato

Estrutura no disco:

```text
~/.cursor/chats/
  <workspace-id>/
    <agent-id>/
      store.db
```

Estrutura SQLite:

```text
store.db
  meta
    key='0'
    value='<hex-json>'

  blobs
    id='<hash-like-id>'
    data='<binary-or-json-or-text>'
```

Fluxo de leitura:

```text
store.db
  -> meta[0]
    -> hex decode
      -> JSON
        -> latestRootBlobId
          -> blobs[latestRootBlobId]
            -> protobuf root
              -> references to other blobs
```

Mensagem JSON:

```text
blobs.data starts with 0x7B ('{')
  -> CAST(data AS TEXT)
  -> json_valid(...)
  -> json_extract(..., '$.role')
```

Blob protobuf:

```text
blobs.data starts with 0x0A, 0x12 or 0x1A
  -> save bytes
  -> protoc --decode_raw
```

Blob texto:

```text
blobs.data starts with printable ASCII
  -> CAST(data AS TEXT)
  -> inspect prefix or save out
```

### Campos de navegação

Para navegar programaticamente pelo armazenamento:

- `workspaceId`: vem do diretório `~/.cursor/chats/<workspace-id>/`.
- `agentId`: vem do diretório `<agent-id>` e também de `meta.agentId`.
- `createdAt`: vem de `meta.createdAt`, em milissegundos Unix.
- `mode`: vem de `meta.mode`.
- `model`: vem de `meta.lastUsedModel`, quando existe.
- `latestRootBlobId`: vem de `meta.latestRootBlobId`.
- `blobId`: vem de `blobs.id`.
- `role`: vem de `json_extract(CAST(data AS TEXT), '$.role')` em blobs JSON.
- `message id`: vem de `.id` nas mensagens `assistant`, `tool` e parte das
  mensagens `user`.
- `toolCallId`: liga `assistant.content[].tool-call` a
  `tool.content[].tool-result`.
- `toolName`: identifica a ferramenta em chamadas e resultados.
- `providerOptions.cursor.requestId`: aparece em parte das mensagens `user`.

Diferença importante em relação ao Claude Code: nos blobs JSON do Cursor não há
um campo universal equivalente a `timestamp`, `uuid` e `parentUuid` por evento.
A ordem completa da conversa depende do estado protobuf referenciado pelo root
blob. Para busca textual, os blobs JSON bastam; para reconstrução fiel de
timeline, é preciso decodificar melhor o protobuf.

Exemplo de índice JSONL navegável:

```bash
find "$HOME/.cursor/chats" -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  workspace_id="$(basename "$(dirname "$(dirname "$db")")")"
  agent_id="$(basename "$(dirname "$db")")"

  meta="$(
    sqlite3 "file:$db?mode=ro&immutable=1" \
      "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    while IFS= read -r hex; do
      printf '%s' "$hex" | xxd -r -p 2>/dev/null
    done
  )"

  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT id, CAST(data AS TEXT)
     FROM blobs
     WHERE hex(substr(data,1,1))='7B'
       AND json_valid(CAST(data AS TEXT))
       AND json_extract(CAST(data AS TEXT),'$.role') IS NOT NULL;" 2>/dev/null |
  while IFS='|' read -r blob_id json; do
    printf '%s' "$json" |
    jq -c \
      --arg db "$db" \
      --arg workspace_id "$workspace_id" \
      --arg agent_id "$agent_id" \
      --arg blob_id "$blob_id" \
      --argjson meta "$meta" \
      '{
        db: $db,
        workspaceId: $workspace_id,
        agentId: $agent_id,
        blobId: $blob_id,
        createdAt: ($meta.createdAt // null),
        mode: ($meta.mode // null),
        model: ($meta.lastUsedModel // null),
        latestRootBlobId: ($meta.latestRootBlobId // null),
        role: (.role // null),
        messageId: (.id // null)
      }'
  done
done
```

## 14. Cuidados

1. Nao use comandos destrutivos enquanto estiver investigando.

   Esses bancos guardam histórico local de conversas/agentes. Apagar diretórios
   em `~/.cursor/chats` remove histórico local.

2. Prefira URI SQLite com `mode=ro`.

   Isso reduz o risco de tocar nos bancos:

   ```bash
   sqlite3 "file:$db?mode=ro&immutable=1" "..."
   ```

3. Feche o Cursor se precisar de snapshot perfeito.

   `immutable=1` evita locks, mas se houver WAL ativo, ele pode não representar
   exatamente o estado mais novo.

4. Nao assuma que todo blob é UTF-8.

   Muitos blobs são protobuf/binários. Antes de fazer `CAST(data AS TEXT)`,
   classifique pelo prefixo ou restrinja para JSON válido.

5. Nao assuma que todo JSON é mensagem.

   Alguns blobs JSON podem ser arquivos ou configuração. Para mensagens, filtre
   por `$.role`.

6. `meta.value` precisa de duas etapas.

   Primeiro leia o texto hexadecimal, depois faça `xxd -r -p`, depois `jq`.

## 15. Comandos de sanidade

Checar schema de todos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" ".schema" 2>/dev/null |
    tr '\n' ' '
  echo
done |
sort |
uniq -c
```

Checar se todos têm uma linha em `meta`:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" "SELECT count(*) FROM meta;" 2>/dev/null
done |
sort |
uniq -c
```

Contar blobs em todos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" "SELECT count(*) FROM blobs;" 2>/dev/null
done |
awk '{s+=$1; n++} END{print "dbs", n, "blob_rows", s}'
```

Contar modos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    xxd -r -p |
    jq -r '.mode // empty' 2>/dev/null
done |
sort |
uniq -c |
sort -nr
```

Contar modelos:

```bash
find ~/.cursor/chats -type f -name 'store.db' -print0 |
while IFS= read -r -d '' db; do
  sqlite3 "file:$db?mode=ro&immutable=1" \
    "SELECT value FROM meta WHERE key='0';" 2>/dev/null |
    xxd -r -p |
    jq -r 'select(.lastUsedModel != null) | .lastUsedModel' 2>/dev/null
done |
sort |
uniq -c |
sort -nr
```

## 16. Conclusao

Os `store.db` em `~/.cursor/chats` sao bancos SQLite usados pelo Cursor Agent
para persistir historico e estado local de sessoes.

O design e minimalista:

- uma tabela `meta` com estado de topo, incluindo o ponteiro para o root blob;
- uma tabela `blobs` com objetos enderecados por hash;
- mensagens e configuracoes em JSON;
- estado interno em protobuf/binario;
- arquivos, diffs e saidas de ferramenta como texto ou fragmentos binarios.

Para recuperar dados com seguranca:

1. abra os bancos com `mode=ro&immutable=1`;
2. decodifique `meta.value` com `xxd -r -p`;
3. use `latestRootBlobId` para seguir o root;
4. classifique `blobs.data` pelo primeiro byte;
5. leia JSON com `json_valid` e `json_extract`;
6. leia binario wire-compatible com protobuf usando `protoc --decode_raw`;
7. exporte resultados para JSONL antes de deduplicar ou gerar arquivos finais.
