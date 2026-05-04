## 1. Resumo executivo

Minha recomendação principal: **X deve ser um formato híbrido local-first**: um diretório-bundle contendo **um SQLite como catálogo canônico e projeção consultável**, um **object store content-addressed** para dados brutos e conteúdos grandes, uma camada **SQLite FTS5** inicial para busca textual, e **exports derivados em Parquet/DuckDB** para análise pesada. Não faria X como “um JSONL gigante”, nem como “só Parquet”, nem como “só DuckDB”.

O formato que eu mais copiaria semanticamente é uma mistura de **Claude Code + Codex**: Claude tem melhor estrutura para timeline, `uuid`, `parentUuid`, subagentes e artefatos externos; Codex tem o melhor envelope de eventos, `turn_context`, eventos operacionais e relação por `call_id`. Do Cursor eu copiaria **content-addressing / blob store**, mas não copiaria o estado binário/protobuf como parte essencial do formato canônico. Do Gemini eu copiaria pouco: a simplicidade do objeto de sessão e `toolCalls[]`, mas não o modelo de arquivo JSON inteiro como armazenamento escalável.

A decisão crítica é esta: **raw preservation é obrigatório, não opcional**. X deve preservar o original e construir projeções normalizadas reconstruíveis. A fonte da verdade não deve ser “o Markdown exportado” nem “o índice de busca”; deve ser o conjunto de `raw_records` + `objects` + schema versionado + importador determinístico.

---

## 2. Comparação dos quatro formatos

### Visão geral dos formatos observados

| Ferramenta   | Formato observado                                                                                                                                       | Ponto forte                                                                                                                                          | Ponto fraco arquitetural                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cursor Agent | Muitos `store.db`, cada um SQLite com `meta` e `blobs`; blobs JSON, texto e protobuf/binário; `latestRootBlobId` aponta para root blob                  | Object store local, lookup por blob id, bom para preservar estado bruto e possível dedup                                                             | Timeline semântica é fraca sem decodificar protobuf; mensagens JSON não têm timestamp universal; leitura humana ruim; `meta.value` em hex-JSON é uma má decisão para inspeção  |
| Codex CLI    | `rollout-*.jsonl` por data; eventos envelopados com `type`, `timestamp`, `payload`; inclui `session_meta`, `turn_context`, `response_item`, `event_msg` | Melhor log operacional; append-friendly; rico para auditar comandos, patches, MCP, compactação, turnos e subagentes                                  | Mistura transcript, UI events, reasoning, estado legado e outputs grandes no mesmo JSONL; precisa normalização forte                                                           |
| Claude Code  | Árvore por projeto; JSONL por sessão principal; JSONL por subagente; `tool-results/`; `memory/`; `sessions-index.json` auxiliar e incompleto            | Melhor estrutura causal/timeline; `uuid`, `parentUuid`, `sessionId`, `isSidechain`, `agentId`, `sourceToolAssistantUUID`; artefatos grandes externos | Muitos arquivos; índice incompleto; `type: system` é operacional, não system prompt; tool result pode estar duplicado em formatos diferentes                                   |
| Gemini CLI   | `chats/session-*.json` como objeto JSON comum; `logs.json`; `.project_root`; `toolCalls[]` embutidos                                                    | Simples de ler; bom para sessões pequenas; mensagens, tokens, thoughts e tool calls estão em um objeto                                               | Menos escalável para append; duplicatas de `sessionId`; logs não cobrem chats integralmente; tool outputs e diffs embutidos podem crescer muito                                |

### Vencedor por critério

| Critério                         | Vencedor                                                          | Por quê                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eficiência de escrita            | **Codex**                                                         | JSONL append-only é a forma mais simples e robusta para anexar eventos continuamente. Cursor também escreve bem internamente via SQLite/WAL, mas é menos transparente e fragmentado em muitos DBs. |
| Eficiência de leitura sequencial | **Codex / Claude**                                                | JSONL permite streaming linha a linha. Claude ainda tem separação por projeto/sessão/subagente; Codex tem árvore por data e um arquivo por sessão/sub-sessão.                                      |
| Eficiência de leitura seletiva   | **Cursor para lookup bruto; Claude/Codex para leitura semântica** | Cursor é bom se você sabe o `blobId`. Mas para perguntar “quais comandos Bash falharam no projeto X?”, Claude e Codex vencem porque os eventos estão em JSON estruturado.                          |
| Facilidade de indexação          | **Claude**                                                        | Tem `timestamp`, `uuid`, `parentUuid`, `sessionId`, `cwd`, `gitBranch`, `isSidechain`, `agentId`. Isso facilita construir um índice fiel de eventos e relações.                                    |
| Full-text search                 | **Claude / Codex**                                                | Dá para usar `rg` diretamente nos JSONL. Claude exige incluir `tool-results/`; Codex concentra mais coisas no JSONL. Cursor exige extrair blobs; Gemini é simples, mas menos completo.             |
| Reconstrução de timeline         | **Claude**                                                        | Ordem de linha, `timestamp`, `uuid` e `parentUuid` dão a melhor base. Codex é bom por timestamp e ordem de arquivo, mas menos forte em parent graph. Cursor é fraco sem protobuf.                  |
| Dados grandes de ferramentas     | **Claude**                                                        | Separar saídas grandes em `tool-results/` é a melhor decisão entre os quatro. Codex/Gemini embutem muita coisa; Cursor usa blobs, mas com semântica menos clara.                                   |
| Preservação de proveniência      | **Claude / Codex**                                                | Ambos mantêm caminho, sessão, timestamp, tipo de evento e IDs. Cursor preserva bytes, mas perde semântica se o protobuf não for decodificado.                                                      |
| Deduplicação                     | **Cursor**                                                        | O design com `blobs.id` hash-like é o melhor sinal de object store/dedup. O relatório não confirma que é exatamente `sha256(data)`, então isso deve ser tratado como inferência, não fato.         |
| Subagentes e relações causais    | **Claude**                                                        | Subagentes têm diretório próprio, `isSidechain`, `agentId`, mesmo `sessionId` e `sourceToolAssistantUUID`. Codex vem em segundo com `source.subagent.thread_spawn.parent_thread_id`.               |
| Consultas analíticas             | **Codex**                                                         | Tem muitos eventos operacionais: `exec_command_end`, `patch_apply_end`, `mcp_tool_call_end`, `token_count`, `context_compacted`, etc. É o melhor para auditoria operacional.                       |
| Simplicidade de implementação    | **Gemini / Codex**                                                | Gemini é trivial para poucos arquivos. Codex é simples e mais escalável por ser JSONL. Claude exige lidar com árvore maior; Cursor exige SQLite + blobs + protobuf.                                |
| Portabilidade                    | **Codex / Claude / Gemini**                                       | JSONL/JSON ganham. SQLite também é portátil, mas Cursor esconde muita semântica em blobs binários.                                                                                                 |
| Evolução de schema               | **Codex**                                                         | Envelope `type` + `payload` é uma boa inspiração. Permite novos tipos sem quebrar todos os leitores.                                                                                               |
| Legibilidade humana              | **Gemini / Claude / Codex**                                       | JSON/JSONL é legível. Cursor é o pior aqui por BLOB/protobuf e hex-JSON em `meta`.                                                                                                                 |
| Migração/reprocessamento         | **Claude / Codex**                                                | Reprocessar JSONL é direto. Gemini precisa snapshot semantics. Cursor exige extrair e classificar blobs e aceitar incerteza de timeline.                                                           |

Conclusão crítica: **nenhum dos quatro é bom o suficiente como formato X sozinho**. O Codex é o melhor modelo de log de eventos; o Claude é o melhor modelo de grafo/timeline/subagentes; o Cursor é o melhor lembrete de que conteúdo grande deve ser endereçado por hash; o Gemini é bom como caso simples, mas ruim como inspiração principal.

---

## 3. Diagnóstico

### Cursor

O Cursor faz bem uma coisa importante: ele separa estado/metadados de blobs e usa uma tabela `blobs(id, data)` que parece funcionar como object store endereçado por hash. Isso é uma excelente ideia para X. Conteúdo grande, saídas, fragmentos, arquivos e mensagens podem virar objetos deduplicáveis.

Mas o Cursor é ruim como formato canônico de conversa. A ausência de `timestamp`, `uuid` e `parentUuid` universais nos blobs JSON torna a reconstrução de timeline frágil. O relatório deixa claro que a ordem completa depende do estado protobuf referenciado pelo root blob. Portanto, qualquer importador do Cursor precisa ter `timeline_confidence = low` até decodificar melhor o protobuf. Fingir que a ordem dos blobs é a ordem da conversa seria erro arquitetural.

Decisões ruins do Cursor a evitar: `meta.value` como JSON codificado em hexadecimal; estado semântico crítico em protobuf não documentado; múltiplos DBs pequenos espalhados; mensagens e ferramenta recuperáveis apenas por heurística; falta de timestamp por mensagem JSON.

### Codex

O Codex é o formato mais eficiente como **event log operacional**. O envelope `type/timestamp/payload` é uma das melhores decisões entre os quatro. `session_meta` dá identidade e cwd; `turn_context` dá modelo, sandbox, política de aprovação, resumo e instruções por turno; `response_item` representa transcript e chamadas de modelo; `event_msg` captura eventos operacionais como comando executado, patch aplicado, MCP, abortos e compactação. Isso é quase o que X precisa, só que ainda bruto demais.

O problema do Codex é que ele mistura camadas: transcript, UI events, tool calls, outputs, compactação e registros legados no mesmo fluxo. Isso é normal para log, mas ruim para consulta se não houver normalização. Outro problema: outputs grandes ficam embutidos no JSONL; isso favorece escrita append-only, mas prejudica dedup, busca seletiva e tamanho de índice.

Decisões boas a copiar: envelope de evento, `turn_context`, `call_id`, eventos operacionais explícitos, subagente como sessão separada com relação pai.

Decisões a evitar: depender só de JSONL para consulta seletiva; deixar output grande embutido sem object store; misturar registros legados sem `type` com eventos atuais sem uma camada de normalização.

### Claude Code

O Claude Code é o melhor em modelagem semântica local. Ele dá a melhor base para timeline e grafo: `sessionId`, `uuid`, `parentUuid`, `isSidechain`, `agentId`, `sourceToolAssistantUUID`, `tool_use.id`, `tool_result.tool_use_id`. A separação de `tool-results/` para outputs grandes é uma decisão correta. A árvore por projeto também ajuda descoberta e navegação.

Mas há problemas. `sessions-index.json` é explicitamente incompleto, então não pode ser fonte da verdade. `type: "system"` é operacional, não system prompt; se X não distinguir isso, seus exports e buscas vão mentir. Resultados de ferramenta podem aparecer em `message.content[].tool_result` e também em `toolUseResult`, às vezes duplicados ou mais estruturados. Subagentes são muitos; ignorá-los destruiria parte relevante da atividade.

Decisões boas a copiar: `uuid`/`parentUuid`, line order, subagentes explícitos, artefatos externos, metadata por projeto, separação de memória/projeto.

Decisões a evitar: índice auxiliar incompleto como fonte primária; nomes de projeto derivados de path como se fossem reversíveis; overload de `system`; duplicidade de tool result sem normalização.

### Gemini

O Gemini é o formato mais fácil de ler em baixa escala. `sessionId`, `projectHash`, `startTime`, `lastUpdated`, `messages[]`, `toolCalls[]`, `tokens` e `thoughts` são diretos. Para um importador, ele é agradável.

Mas é o menos convincente como arquitetura canônica. Um JSON inteiro por sessão escala pior para append e atualizações. `logs.json` só contém entradas de usuário e nem sempre tem chat correspondente. Há `sessionId` repetidos em mais de um arquivo, então X precisa tratar arquivos como snapshots ou versões, não como sessões independentes. `resultDisplay.newContent` e `originalContent` podem conter arquivos inteiros, então o JSON pode crescer e bagunçar busca/exportação.

Decisões boas a copiar: sessão com header claro; `toolCalls[]` dentro da mensagem do modelo; `resultDisplay` para diffs; `.project_root` para path real quando existir.

Decisões a evitar: JSON inteiro como unidade mutável; logs separados e incompletos como índice; não distinguir claramente snapshot de sessão; embutir diffs/arquivos grandes sem CAS.

### Problemas ao unificar

O maior problema não é formato de arquivo; é **semântica incompatível**.

Um “system” no Cursor pode ser mensagem de sistema; no Claude `type: "system"` é evento operacional. Um resultado de ferramenta pode ser uma mensagem `tool`, um bloco `tool_result`, um `event_msg`, um `toolUseResult`, um `toolCalls[].result`, ou um arquivo externo. Um subagente pode ser uma sessão separada, um sidechain dentro do mesmo `sessionId`, ou pode nem estar modelado. Uma compactação pode ser evento, snapshot, summary, replacement history ou campo de contexto.

Portanto X não deve tentar “converter tudo para mensagens”. Isso seria uma arquitetura fraca. X deve modelar **eventos, mensagens, blocos, ferramentas, artefatos e edges** separadamente.

---

## 4. Proposta do formato X

### Resposta direta: banco único, árvore, Parquet, SQLite, DuckDB ou híbrido?

**Híbrido.**

Eu faria X como um bundle local:

```text
x-store/
  manifest.json
  x.sqlite
  objects/
    blake3/
      ab/cd/<hash>.zst
  raw/
    sources/
      <source-file-hash>.zst
  search/
    tantivy/              # opcional, depois do MVP
  parquet/
    events/
    messages/
    tool_calls/
    tool_results/
    artifacts/
  exports/
```

`x.sqlite` é o catálogo canônico consultável. `objects/` guarda bytes grandes, raw records, outputs, diffs, imagens, JSON bruto e texto grande por hash. `raw/sources/` pode guardar cópias comprimidas dos arquivos de origem para auditoria. `parquet/` é derivado, não fonte da verdade. `search/` também é derivado.

Essa arquitetura vence as alternativas simples:

“Banco único com tudo em BLOB” fica pesado e menos prático para outputs grandes. “Árvore de arquivos” é portátil, mas ruim para filtros combináveis. “Só Parquet” é ótimo para analytics e ruim para event graph, FTS, reimportação incremental e edição de índices. “Só DuckDB” é tentador, mas eu não usaria como fonte canônica: ele é excelente para análise, especialmente lendo Parquet com pushdown de filtros/projeções, mas o problema principal de X é catálogo incremental + provenance + busca + grafo. DuckDB entra melhor como motor analítico derivado. DuckDB suporta leitura eficiente de Parquet, incluindo pushdown de filtros e leitura só das colunas relevantes, então ele é perfeito para a camada analítica, não para a camada canônica. ([DuckDB][1])

### Modelo lógico

X deve ser um **event graph normalizado**.

A unidade conceitual principal não é “mensagem”. É:

```text
source raw record
  -> event
    -> message(s)
      -> content_block(s)
    -> tool_call(s)
    -> tool_result(s)
    -> artifact(s)
    -> edge(s)
```

Nem todo evento vira mensagem. Nem toda mensagem tem texto. Nem todo tool result pertence a uma mensagem. Nem todo artifact tem texto indexável. Essa separação evita gambiarras.

### Modelo físico

O modelo físico deve ter três camadas:

Primeira camada: **raw imutável**. Cada linha JSONL, cada objeto Gemini, cada blob Cursor, cada arquivo `tool-results`, cada `logs.json` entry vira um `raw_record` com ponteiro para bytes preservados.

Segunda camada: **projeções normalizadas**. Tabelas como `sessions`, `events`, `messages`, `content_blocks`, `tool_calls`, `tool_results`, `artifacts`, `edges`. Essas tabelas podem ser reconstruídas se o parser melhorar.

Terceira camada: **índices derivados**. `search_docs` + FTS5; materializações para timeline; Parquet para DuckDB; eventualmente Tantivy. SQLite FTS5 é uma boa base porque é um módulo de tabela virtual para full-text search dentro do próprio SQLite. ([SQLite][2])

### Estratégia de índices

Use SQLite para filtros e joins:

```sql
sessions(source_tool, source_session_id)
sessions(project_id, start_ts, end_ts)
events(session_id, timestamp, ordinal)
events(event_type, subtype)
messages(session_id, role, timestamp)
content_blocks(message_id, block_type)
tool_calls(session_id, tool_name, status)
tool_calls(command_hash)
tool_results(call_id, is_error, exit_code)
artifacts(session_id, kind, path_hash)
edges(src_type, src_id, edge_type)
edges(dst_type, dst_id, edge_type)
raw_records(source_file_id, ordinal)
```

Use FTS5 para texto:

```text
search_docs:
  doc_id
  entity_type
  entity_id
  session_id
  project_id
  timestamp
  role
  tool_name
  field_kind
  text
```

Indexe texto conversacional, comandos, paths, erros, nomes de ferramentas, summaries e metadados relevantes. Não jogue bytes gigantes crus no FTS. Para outputs grandes, indexe preview + chunks textuais classificados.

### Estratégia de raw preservation

Cada importação deve preservar:

```text
source_tool
source_path
source_file_hash
source_file_size
mtime
raw locator:
  line number / byte range / JSON pointer / SQLite table+rowid / blob id
raw bytes hash
parser version
import batch id
normalization confidence
```

Para Cursor, `raw_record` pode ser `meta[0]`, cada linha de `blobs`, root blob decodificado parcial e cada blob JSON extraído. Para Codex/Claude, cada linha JSONL é um raw record. Para Gemini, o arquivo inteiro é raw source e cada `messages[i]`, `toolCalls[j]`, `logs[k]` vira raw record com JSON pointer.

### Estratégia de deduplicação

Use content-addressing com **BLAKE3 como hash primário** e, opcionalmente, SHA-256 como hash secundário para interoperabilidade/forense. BLAKE3 é adequado aqui porque é criptográfico, rápido, paralelizável e suporta uso eficiente em streaming. ([GitHub][3])

Guarde objetos comprimidos com Zstandard. Zstd é uma boa escolha local porque é lossless, rápido e tem bom trade-off de compressão/descompressão. ([Facebook GitHub][4])

Regra importante: deduplicação de bytes não deve apagar proveniência. O mesmo `object_id` pode ter 50 `object_refs`, cada um apontando para sessão, mensagem, tool result e raw record diferentes.

---

## 5. Schema canônico

Abaixo está um schema prático. Não é “mínimo acadêmico”; é o que eu construiria para não me arrepender depois.

### `objects`

Guarda conteúdo endereçado por hash.

| Campo                   | Tipo      | Status      | Observação                                     |
| ----------------------- | --------- | ----------- | ---------------------------------------------- |
| `object_id`             | text      | obrigatório | Ex.: `blake3:<hash>`                           |
| `hash_alg`              | text      | obrigatório | `blake3`, opcionalmente `sha256` secundário    |
| `hash`                  | text      | obrigatório | Hash dos bytes descomprimidos                  |
| `size_bytes`            | integer   | obrigatório | Tamanho original                               |
| `compressed_size_bytes` | integer   | opcional    | Tamanho no disco                               |
| `compression`           | text      | obrigatório | `zstd`, `none`                                 |
| `mime_type`             | text      | opcional    | `application/json`, `text/plain`, `image/jpeg` |
| `encoding`              | text      | opcional    | `utf-8`, `binary`, etc.                        |
| `storage_path`          | text      | obrigatório | Path relativo em `objects/`                    |
| `created_at`            | timestamp | obrigatório | Quando X armazenou                             |

### `source_files`

Representa arquivos de origem encontrados.

| Campo            | Status      | Observação                                                 |
| ---------------- | ----------- | ---------------------------------------------------------- |
| `source_file_id` | obrigatório | ID interno determinístico                                  |
| `source_tool`    | obrigatório | `cursor`, `codex`, `claude`, `gemini`                      |
| `path`           | obrigatório | Path original                                              |
| `file_kind`      | obrigatório | `jsonl`, `json`, `sqlite`, `tool_result`, `memory`, `blob` |
| `size_bytes`     | obrigatório | Tamanho                                                    |
| `mtime`          | opcional    | Mtime do filesystem                                        |
| `object_id`      | opcional    | Cópia preservada do arquivo                                |
| `content_hash`   | obrigatório | Hash do arquivo                                            |
| `discovered_at`  | obrigatório | Data de descoberta                                         |
| `is_snapshot`    | derivado    | Especialmente útil no Gemini                               |
| `workspace_hint` | opcional    | Ex.: Cursor workspace id, Claude project slug              |

### `raw_records`

A base de reprocessamento.

| Campo                    | Status      | Observação                                                                  |
| ------------------------ | ----------- | --------------------------------------------------------------------------- |
| `raw_record_id`          | obrigatório | Determinístico por source file + locator + hash                             |
| `source_file_id`         | obrigatório | FK                                                                          |
| `source_tool`            | obrigatório | Redundante, mas útil                                                        |
| `record_kind`            | obrigatório | `jsonl_line`, `json_pointer`, `sqlite_meta`, `sqlite_blob`, `external_file` |
| `ordinal`                | opcional    | Linha JSONL, índice array, blob ordinal                                     |
| `line_no`                | opcional    | JSONL                                                                       |
| `byte_start`, `byte_end` | opcional    | Se disponível                                                               |
| `json_pointer`           | opcional    | Gemini `$.messages[3].toolCalls[0]`                                         |
| `sqlite_table`           | opcional    | Cursor `meta` ou `blobs`                                                    |
| `sqlite_key`             | opcional    | Cursor `blobId`, `meta key`                                                 |
| `native_id`              | opcional    | `uuid`, `message.id`, `call_id`, etc.                                       |
| `raw_object_id`          | obrigatório | Bytes do record bruto                                                       |
| `decoded_json_object_id` | opcional    | JSON canônico se parseável                                                  |
| `parser_status`          | obrigatório | `ok`, `partial`, `failed`                                                   |
| `confidence`             | obrigatório | `high`, `medium`, `low`                                                     |
| `import_batch_id`        | obrigatório | FK                                                                          |

### `projects`

| Campo                      | Status      | Observação                                           |
| -------------------------- | ----------- | ---------------------------------------------------- |
| `project_id`               | obrigatório | ID interno                                           |
| `canonical_path`           | opcional    | Path real se conhecido                               |
| `path_hash`                | derivado    | Para dedup sem depender de string                    |
| `source_project_id`        | opcional    | Cursor workspace id, Gemini projectHash, Claude slug |
| `display_name`             | opcional    | Nome humano                                          |
| `repo_url`                 | opcional    | Se extraído                                          |
| `created_at`, `updated_at` | derivado    | A partir das sessões                                 |

### `workspaces`

Eu separaria `projects` de `workspaces`, porque Cursor tem workspace-id opaco e Claude/Gemini têm path/projeto.

| Campo                 | Status      | Observação                                                   |
| --------------------- | ----------- | ------------------------------------------------------------ |
| `workspace_id`        | obrigatório | Interno                                                      |
| `source_tool`         | obrigatório |                                                              |
| `source_workspace_id` | obrigatório | Cursor workspace id, Gemini projectHash, Claude project slug |
| `project_id`          | opcional    | FK se resolvido                                              |
| `root_path`           | opcional    | Path real                                                    |
| `confidence`          | obrigatório | Path slug nem sempre é reversível                            |

### `sessions`

| Campo                 | Status      | Observação                                     |
| --------------------- | ----------- | ---------------------------------------------- |
| `session_id`          | obrigatório | ID X                                           |
| `source_tool`         | obrigatório |                                                |
| `source_session_id`   | obrigatório | `sessionId`, `agentId`, filename id, etc.      |
| `project_id`          | opcional    | FK                                             |
| `workspace_id`        | opcional    | FK                                             |
| `parent_session_id`   | opcional    | Subagentes                                     |
| `is_subagent`         | obrigatório | boolean                                        |
| `agent_id`            | opcional    | Claude/Cursor                                  |
| `agent_role`          | opcional    | Codex `explorer`, `awaiter`; Claude agent type |
| `title`               | opcional    | Custom title, first prompt, name               |
| `summary`             | opcional    | Session summary                                |
| `start_ts`            | opcional    | Fonte                                          |
| `end_ts`              | opcional    | Derivado                                       |
| `created_source_ts`   | opcional    | Cursor `createdAt`, Gemini `startTime`, etc.   |
| `modified_source_ts`  | opcional    | Claude/Gemini modified                         |
| `cwd_initial`         | opcional    |                                                |
| `git_branch_initial`  | opcional    |                                                |
| `status`              | opcional    | `complete`, `aborted`, `unknown`               |
| `timeline_confidence` | obrigatório | Especialmente para Cursor                      |
| `raw_record_id`       | opcional    | Meta principal                                 |

### `turns`

| Campo                | Status      | Observação           |
| -------------------- | ----------- | -------------------- |
| `turn_id`            | obrigatório | ID X                 |
| `session_id`         | obrigatório |                      |
| `source_turn_id`     | opcional    | Codex `turn_id`      |
| `ordinal`            | obrigatório | Se inferível         |
| `start_ts`, `end_ts` | opcional    |                      |
| `model`              | opcional    |                      |
| `cwd`                | opcional    |                      |
| `git_branch`         | opcional    |                      |
| `approval_policy`    | opcional    | Codex                |
| `sandbox_policy`     | opcional    | Codex                |
| `effort`             | opcional    | Codex                |
| `summary`            | opcional    | Compactação/contexto |
| `raw_record_id`      | opcional    |                      |

### `events`

| Campo               | Status      | Observação                                                                                                                 |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `event_id`          | obrigatório | ID X                                                                                                                       |
| `session_id`        | obrigatório |                                                                                                                            |
| `turn_id`           | opcional    |                                                                                                                            |
| `source_event_id`   | opcional    | Claude `uuid`, Codex event id se houver                                                                                    |
| `event_type`        | obrigatório | `message`, `tool_call`, `tool_result`, `progress`, `system_operational`, `attachment`, `compaction`, `patch`, `exec`, etc. |
| `source_type`       | obrigatório | Ex.: Claude `assistant`, Codex `event_msg.exec_command_end`                                                                |
| `subtype`           | opcional    |                                                                                                                            |
| `timestamp`         | opcional    |                                                                                                                            |
| `ordinal`           | opcional    | Linha/array index                                                                                                          |
| `actor`             | opcional    | `user`, `assistant`, `tool`, `system`, `cli`                                                                               |
| `payload_object_id` | obrigatório | JSON/payload bruto normalizado                                                                                             |
| `raw_record_id`     | obrigatório | Proveniência                                                                                                               |
| `confidence`        | obrigatório |                                                                                                                            |
| `is_derived`        | obrigatório | Se evento foi inferido                                                                                                     |

### `messages`

| Campo               | Status      | Observação                                                               |
| ------------------- | ----------- | ------------------------------------------------------------------------ |
| `message_id`        | obrigatório | ID X                                                                     |
| `session_id`        | obrigatório |                                                                          |
| `turn_id`           | opcional    |                                                                          |
| `event_id`          | opcional    | FK                                                                       |
| `source_message_id` | opcional    | Claude `message.id`, Cursor `.id`, Gemini `messages[].id`                |
| `role`              | obrigatório | `system_prompt`, `developer`, `user`, `assistant`, `tool`, `operational` |
| `author_name`       | opcional    | Agent nickname, tool name                                                |
| `model`             | opcional    |                                                                          |
| `timestamp`         | opcional    |                                                                          |
| `ordinal`           | opcional    |                                                                          |
| `parent_message_id` | opcional    | Derivado de `parentUuid`/edges                                           |
| `request_id`        | opcional    |                                                                          |
| `status`            | opcional    |                                                                          |
| `raw_record_id`     | obrigatório |                                                                          |

Nota: eu **não** usaria `role = system` de forma ambígua. Separaria `system_prompt` de `system_operational`.

### `content_blocks`

| Campo            | Status      | Observação                                                                                                           |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `block_id`       | obrigatório |                                                                                                                      |
| `message_id`     | opcional    |                                                                                                                      |
| `event_id`       | opcional    |                                                                                                                      |
| `session_id`     | obrigatório |                                                                                                                      |
| `ordinal`        | obrigatório |                                                                                                                      |
| `block_type`     | obrigatório | `text`, `input_text`, `output_text`, `tool_use`, `tool_result`, `thinking`, `image`, `attachment`, `diff`, `summary` |
| `text_object_id` | opcional    | Para texto grande                                                                                                    |
| `text_inline`    | opcional    | Para texto pequeno                                                                                                   |
| `mime_type`      | opcional    |                                                                                                                      |
| `token_count`    | opcional    |                                                                                                                      |
| `is_error`       | opcional    |                                                                                                                      |
| `is_redacted`    | obrigatório |                                                                                                                      |
| `visibility`     | opcional    | `default`, `hidden_by_default`, `audit_only`                                                                         |
| `raw_record_id`  | obrigatório |                                                                                                                      |

Eu marcaria blocos de `thinking`/`reasoning` como `hidden_by_default` no export Markdown. Devem existir para auditoria, mas não devem poluir transcript comum.

### `tool_calls`

| Campo                 | Status                        | Observação                                                                          |
| --------------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| `tool_call_id`        | obrigatório                   | ID X                                                                                |
| `session_id`          | obrigatório                   |                                                                                     |
| `turn_id`             | opcional                      |                                                                                     |
| `message_id`          | opcional                      | Mensagem que chamou                                                                 |
| `event_id`            | opcional                      |                                                                                     |
| `source_call_id`      | obrigatório quando disponível | Claude `tool_use.id`, Codex `call_id`, Cursor `toolCallId`, Gemini `toolCalls[].id` |
| `tool_name`           | obrigatório                   | `Bash`, `Read`, `Shell`, etc.                                                       |
| `canonical_tool_type` | derivado                      | `shell`, `read_file`, `write_file`, `search`, `web`, `mcp`, `subagent`, `patch`     |
| `args_object_id`      | opcional                      | JSON dos argumentos                                                                 |
| `command`             | opcional                      | Shell                                                                               |
| `cwd`                 | opcional                      |                                                                                     |
| `path`                | opcional                      | Arquivo principal                                                                   |
| `query`               | opcional                      | Search/web                                                                          |
| `timestamp_start`     | opcional                      |                                                                                     |
| `timestamp_end`       | opcional                      |                                                                                     |
| `status`              | opcional                      | `started`, `success`, `error`, `cancelled`, `unknown`                               |
| `raw_record_id`       | obrigatório                   |                                                                                     |

### `tool_results`

| Campo              | Status      | Observação                 |
| ------------------ | ----------- | -------------------------- |
| `tool_result_id`   | obrigatório |                            |
| `tool_call_id`     | opcional    | Pode ser null se unmatched |
| `session_id`       | obrigatório |                            |
| `message_id`       | opcional    |                            |
| `event_id`         | opcional    |                            |
| `source_call_id`   | opcional    | Para matching              |
| `status`           | opcional    |                            |
| `is_error`         | opcional    |                            |
| `exit_code`        | opcional    | Shell                      |
| `duration_ms`      | opcional    |                            |
| `stdout_object_id` | opcional    |                            |
| `stderr_object_id` | opcional    |                            |
| `output_object_id` | opcional    |                            |
| `preview`          | opcional    | Curto, indexável           |
| `raw_record_id`    | obrigatório |                            |

### `artifacts`

| Campo            | Status      | Observação                                                                                      |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `artifact_id`    | obrigatório |                                                                                                 |
| `session_id`     | opcional    |                                                                                                 |
| `project_id`     | opcional    |                                                                                                 |
| `source_tool`    | obrigatório |                                                                                                 |
| `kind`           | obrigatório | `file`, `tool_output`, `image`, `pdf_page`, `diff`, `patch`, `memory`, `attachment`, `snapshot` |
| `path`           | opcional    | Path original                                                                                   |
| `logical_path`   | opcional    | Path dentro da ferramenta                                                                       |
| `object_id`      | obrigatório | Conteúdo                                                                                        |
| `text_object_id` | opcional    | Texto extraído                                                                                  |
| `mime_type`      | opcional    |                                                                                                 |
| `size_bytes`     | obrigatório |                                                                                                 |
| `created_ts`     | opcional    |                                                                                                 |
| `raw_record_id`  | obrigatório |                                                                                                 |

### `edges`

A tabela mais importante para não perder semântica.

| Campo                | Status      | Observação                                                                                                                                       |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `edge_id`            | obrigatório |                                                                                                                                                  |
| `src_type`, `src_id` | obrigatório |                                                                                                                                                  |
| `dst_type`, `dst_id` | obrigatório |                                                                                                                                                  |
| `edge_type`          | obrigatório | `parent_of`, `calls`, `returns`, `spawned`, `contains`, `produced`, `consumed`, `derived_from`, `summarizes`, `compacts`, `same_as`, `refers_to` |
| `confidence`         | obrigatório | `high`, `medium`, `low`                                                                                                                          |
| `source`             | obrigatório | `explicit`, `path_inferred`, `timestamp_inferred`, `content_inferred`                                                                            |
| `raw_record_id`      | opcional    | Proveniência                                                                                                                                     |
| `metadata_object_id` | opcional    | JSON extra                                                                                                                                       |

### `import_batches`, `import_errors`, `uncertainties`

Essas tabelas não são detalhe burocrático. Elas impedem X de virar uma caixa-preta.

`import_batches`: versão do importador, paths varridos, horário, contagens, status.

`import_errors`: parse errors, arquivos ausentes, blobs inválidos, JSON inválido, protobuf parcial, tool result sem call.

`uncertainties`: eventos importados com baixa confiança, timeline desconhecida, relação inferida, campos ambíguos.

---

## 6. Grafo de relações

### Mensagem pai/filha

Claude dá `parentUuid`; use edge explícita:

```text
event(uuid=A) --parent_of--> event(uuid=B)
message(A) --parent_of--> message(B)
```

Codex pode usar ordem de arquivo, `turn_id`, `thread_id` e eventos, mas a relação pai/filho nem sempre é explícita. Nesse caso, use edge inferida com `confidence=medium`.

Cursor sem protobuf decodificado deve receber no máximo relações por `toolCallId`, não por ordem de conversa.

### Tool call -> tool result

Normalização:

```text
tool_call.source_call_id == tool_result.source_call_id
```

Mapeamento por origem:

```text
Claude: tool_use.id == tool_result.tool_use_id
Codex:  function_call.call_id == function_call_output.call_id
        event_msg.exec_command_end.call_id também liga ao mesmo call
Cursor: assistant.content[].toolCallId == tool.content[].toolCallId
Gemini: toolCalls[].id + posição dentro da mensagem; se result embutido, call e result vêm do mesmo raw record
```

Edge:

```text
tool_call --returns--> tool_result
message --calls--> tool_call
```

### Sessão -> subagente

Claude:

```text
session principal
  --spawned-->
subagent session
```

Use `sourceToolAssistantUUID` e chamadas `Agent` quando disponíveis. Se só o path indicar relação, marque `path_inferred`.

Codex:

```text
payload.source.subagent.thread_spawn.parent_thread_id
```

Crie edge de `parent_session` ou `parent_thread` para sessão do subagente.

Cursor:

O relatório não documenta subagentes com relação causal clara. Não invente. Modele `agentId` como sessão/agente e deixe relação nula até evidência.

Gemini:

O relatório não mostra subagentes como entidade de sessão. `codebase_investigator` pode ser ferramenta, não subagente, salvo evidência contrária.

### Evento -> artifact

Exemplos:

```text
tool_result --produced--> artifact
event(file-history-snapshot) --produced--> artifact(snapshot)
attachment --produced--> artifact
tool_call(read_file) --consumed--> artifact(file)
tool_call(write_file/replace) --produced--> artifact(diff)
```

### Mensagem -> raw record

Toda mensagem deve ter:

```text
message --derived_from--> raw_record
content_block --derived_from--> raw_record
tool_call --derived_from--> raw_record
tool_result --derived_from--> raw_record
```

Isso permite reprocessar e auditar.

### Sessão -> projeto/workspace

Use edge ou FK:

```text
session.project_id
session.workspace_id
```

Mas mantenha edge quando a relação for inferida:

```text
workspace --maps_to--> project
session --belongs_to--> workspace
session --belongs_to--> project
```

Claude project slug não deve ser tratado como path reversível. Gemini `.project_root` é melhor quando existe. Cursor workspace id é opaco.

### Compactação/summary -> mensagens originais

Modele summaries como eventos/blocos:

```text
summary_event --summarizes--> message/event range
compaction_event --compacts--> event range
```

Quando a fonte não disser exatamente quais mensagens foram substituídas, use:

```text
edge_type = "summarizes"
confidence = "low" or "medium"
metadata = {range_strategy: "before_timestamp_in_same_session"}
```

Não finja precisão.

---

## 7. Pipeline de compilação

### Fase 1: descoberta

Varra paths conhecidos:

```text
~/.cursor/chats/**/store.db
~/.codex/sessions/**/*.jsonl
~/.claude/projects/**/*.jsonl
~/.claude/projects/**/tool-results/*
~/.claude/projects/**/memory/*
~/.gemini/tmp/**/chats/session-*.json
~/.gemini/tmp/**/logs.json
~/.gemini/tmp/**/.project_root
```

Calcule hash do arquivo, tamanho, mtime e registre em `source_files`.

### Fase 2: preservação raw

Antes de normalizar, preserve. Para arquivos pequenos e médios, copie comprimido para `raw/sources`. Para SQLite Cursor, copie o trio `store.db`, `store.db-wal`, `store.db-shm` quando possível, porque o relatório alerta que `immutable=1` pode ignorar WAL recente se o Cursor estiver aberto.

### Fase 3: extração por origem

#### Cursor

Importe:

```text
workspace_id pelo path
agent_id pelo path e meta.agentId
meta[0] hex -> JSON
latestRootBlobId
todos os blobs
blobs JSON válidos com role
blobs texto
root blob protobuf bruto
```

Classifique blobs por prefixo e validade JSON. Extraia mensagens `system`, `user`, `assistant`, `tool`, tool calls e tool results. Para timeline, registre `timeline_confidence=low` salvo quando o protobuf for decodificado o bastante para ordenar mensagens.

Não transforme “lista de blobs JSON” em transcript ordenado. Isso seria tecnicamente falso.

#### Codex

Importe cada linha JSONL como raw record. Depois normalize:

```text
session_meta -> sessions
turn_context -> turns
response_item.message -> messages/content_blocks
response_item.function_call -> tool_calls
response_item.function_call_output -> tool_results
event_msg.exec_command_end -> operational event + tool_result/update
event_msg.patch_apply_end -> artifact/diff event
event_msg.mcp_tool_call_end -> tool_result
compacted/context_compacted/ghost_snapshot -> compaction events
source.subagent.thread_spawn -> session edges
```

Registros legados sem envelope devem entrar com `source_format=legacy`.

#### Claude

Importe todos os JSONL, não só `sessions-index.json`. Use `sessions-index.json` apenas como metadata auxiliar, porque ele é incompleto. Normalize:

```text
user/assistant -> messages
message.content[] -> content_blocks
tool_use -> tool_calls
tool_result -> tool_results
toolUseResult -> structured result object
progress -> operational events
attachment -> artifacts/content_blocks
system -> system_operational events
file-history-snapshot -> artifacts/snapshots
subagents/*.jsonl -> sessions com is_subagent=true
agent-*.meta.json -> agent metadata
tool-results/* -> artifacts
memory/* -> project memory artifacts
```

O ponto crítico é não confundir `type: "system"` com mensagem de sistema.

#### Gemini

Importe:

```text
.project_root -> project mapping
logs.json[] -> user log events
chats/session-*.json -> session snapshots
messages[] -> messages
messages[].toolCalls[] -> tool_calls/tool_results/artifacts
thoughts[] -> content_blocks audit_only ou hidden_by_default
tokens -> usage metadata
resultDisplay -> diff/artifact
```

Para `sessionId` duplicado, crie uma sessão lógica e múltiplos snapshots/source_files. Mensagens iguais por `messages[].id` + content hash devem deduplicar; mensagens com mesmo ID e conteúdo diferente devem virar versões, não sobrescrever silenciosamente.

### Fase 4: normalização

A normalização deve fazer:

```text
role mapping
tool name canonicalization
timestamp parsing
project/workspace resolution
large content extraction to objects
tool call/result matching
edge generation
search document generation
```

Exemplo de canonical tool type:

```text
Bash, Shell, run_shell_command -> shell
Read, read_file -> read_file
Write, write_file -> write_file
Edit, replace, StrReplace -> edit_file
Grep, rg, search_file_content -> search_file
WebSearch, google_web_search -> web_search
Agent -> subagent
mcp__* -> mcp
```

Não perca o nome original; `canonical_tool_type` é derivado.

### Fase 5: validação

Valide pelo menos:

```text
contagem de raw records por source_file
contagem de mensagens por sessão
tool_calls sem result
tool_results sem call
parentUuid sem parent
subagentes sem parent
artifacts externos ausentes
timestamps inválidos
sessionId duplicado
raw hash mismatch
JSON parse failed
Cursor protobuf partial
```

Falhas não devem parar a importação inteira. Devem ir para `import_errors` e `uncertainties`.

### Fase 6: reprocessamento

Projeções são descartáveis. Raw não.

Fluxo correto:

```text
raw_records preservados
normalizer v1 gera projeções
normalizer v2 melhora Cursor/Gemini/etc.
apaga projeções afetadas
regera projeções a partir de raw_records
mantém import history
```

### Fase 7: idempotência

Use chaves únicas:

```text
source_files: (source_tool, path, size, mtime, content_hash)
raw_records: (source_file_id, record_kind, locator_hash, raw_hash)
sessions: (source_tool, source_session_id, workspace/project namespace)
messages: (session_id, source_message_id, raw_record_id fallback)
tool_calls: (session_id, source_call_id, raw_record_id fallback)
objects: (hash_alg, hash)
```

A regra é: reimportar o mesmo arquivo não duplica nada; importar uma versão modificada cria novo `source_file`/snapshot, mas reaproveita objetos iguais.

---

## 8. Camada de consulta

### Full-text search

MVP: SQLite FTS5.

Crie `search_docs` e uma FTS externa:

```sql
CREATE TABLE search_docs (
  doc_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT,
  timestamp TEXT,
  role TEXT,
  tool_name TEXT,
  canonical_tool_type TEXT,
  field_kind TEXT,
  text TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_docs_fts
USING fts5(
  text,
  role,
  tool_name,
  field_kind,
  content='search_docs',
  content_rowid='rowid'
);
```

Na prática, talvez você prefira uma tabela FTS sem external content por simplicidade inicial. Mas external content facilita rebuild e metadados.

Indexe em `field_kind`:

```text
message_text
user_prompt
assistant_text
system_prompt
command
command_output_preview
error
file_path
diff
summary
artifact_text
tool_args
tool_result
```

### Filtros rápidos por metadados

Não tente resolver filtros com FTS. FTS é para texto. Filtros devem usar B-tree:

```text
data range -> sessions/events timestamp index
projeto -> sessions.project_id
branch -> turns.git_branch / sessions.git_branch_initial
modelo -> turns.model / messages.model
ferramenta -> tool_calls.tool_name
status/erro -> tool_results.is_error, tool_calls.status
tipo de evento -> events.event_type/subtype
path -> artifacts.path_hash ou tool_calls.path_hash
```

Consulta típica:

```sql
SELECT s.session_id, s.title, snippet(search_docs_fts, ...)
FROM search_docs_fts
JOIN search_docs d ON d.rowid = search_docs_fts.rowid
JOIN sessions s ON s.session_id = d.session_id
LEFT JOIN tool_calls tc ON tc.tool_call_id = d.entity_id
WHERE search_docs_fts MATCH ?
  AND s.project_id = ?
  AND d.timestamp BETWEEN ? AND ?
  AND (tc.canonical_tool_type = 'shell' OR ? IS NULL)
ORDER BY bm25(search_docs_fts), d.timestamp DESC
LIMIT 50;
```

### Consultas analíticas

Para analytics pesado, gere Parquet particionado:

```text
parquet/events/year=2026/month=05/*.parquet
parquet/messages/year=2026/month=05/*.parquet
parquet/tool_calls/year=2026/month=05/*.parquet
parquet/tool_results/year=2026/month=05/*.parquet
parquet/artifacts/*.parquet
```

DuckDB lê Parquet diretamente e é especialmente bom quando você quer agrupar milhões de linhas por modelo, projeto, ferramenta, erro, branch ou mês. Parquet é formato colunar; DuckDB consegue ler só colunas relevantes e aplicar filtros no scan. ([DuckDB][5])

Use Apache Arrow/Parquet como ponte para datasets, não como armazenamento canônico principal. Arrow é um formato colunar voltado a performance analítica e localidade de dados, mas mutações são mais caras; isso reforça que ele deve ser camada derivada, não event store primário. ([Apache Arrow][6])

### Buscar comandos, arquivos, erros, ferramentas, modelos e projetos

Modele campos específicos. Não dependa só de regex no texto.

Comandos:

```text
tool_calls.canonical_tool_type = 'shell'
tool_calls.command
tool_results.exit_code
tool_results.stderr_object_id
```

Arquivos:

```text
tool_calls.path
artifacts.path
resultDisplay.filePath
toolUseResult.file.filePath
patch_apply_end changes
```

Erros:

```text
tool_results.is_error
tool_results.exit_code != 0
events.subtype = api_error
messages.role = operational + severity
Gemini messages.type = error
```

Ferramentas:

```text
tool_calls.tool_name
tool_calls.canonical_tool_type
event_msg.mcp_tool_call_end invocation.server/tool
```

Modelos:

```text
turns.model
messages.model
sessions.model_first/model_last derivados
```

Projetos:

```text
projects.canonical_path
workspaces.source_workspace_id
Gemini projectHash
Claude projectPath/cwd
Codex cwd
Cursor workspaceId + protobuf workspaceUri se decodificado
```

### Timeline eficiente

Crie uma materialized table:

```text
timeline_items:
  session_id
  sort_ts
  sort_ordinal
  item_type
  entity_type
  entity_id
  role
  summary_text
  confidence
```

Para Claude/Codex/Gemini, `sort_ordinal` vem da linha/array. Para Cursor, só preencha `sort_ordinal` quando houver ordem decodificada ou inferência explicitamente marcada.

Timeline não deve ordenar por `blobId`. Isso parece técnico, mas é decisivo: ordenação falsa destrói confiança.

### Quando usar Tantivy

Eu não começaria com Tantivy no MVP, mas deixaria a abstração pronta. Tantivy é uma biblioteca de busca full-text inspirada no Lucene e escrita em Rust; é uma escolha forte se você quiser ranking melhor, índice separado, snippets, campos e performance maior que FTS5 em bases grandes. ([GitHub][7])

Minha recomendação prática:

```text
MVP: SQLite + FTS5
Escala/UX avançada: SQLite metadata + Tantivy search
Analytics: Parquet + DuckDB
```

---

## 9. Exportação Markdown

### Transcript legível

Markdown deve ser renderização, não armazenamento.

Header:

```markdown
# Sessão: <title ou first prompt>

- Fonte: Codex CLI
- Sessão original: <source_session_id>
- Projeto: <canonical_path>
- Branch: <branch>
- Modelos: <model_first> -> <model_last>
- Período: <start_ts> até <end_ts>
- Eventos: 248
- Tool calls: 92
- Raw source: <source file refs>
- Timeline confidence: high
```

Mensagens:

```markdown
## User · 2026-05-03 18:27:41

Texto do usuário.

## Assistant · claude-opus-4-6 · 2026-05-03 18:28:02

Texto do assistente.
```

### Tool calls sem poluir

Não despeje tool output gigante no transcript por padrão. Use blocos recolhíveis ou resumo:

````markdown
### Tool call: Bash · success · 1.2s

`git status --short`

Output: 14 linhas. [artifact: command-output/blake3:...]

```text
preview das primeiras N linhas
````

````

Para erros:

```markdown
### Tool result: Bash · error · exit 1

Comando: `npm test`

Erro resumido:
```text
...
````

Raw output: [artifact ...]

````

Para arquivos alterados:

```markdown
### File edit: src/foo.ts

- Tool: replace
- Status: success
- Diff: [artifact ...]
````

### Metadados e links para artifacts

Use links internos estáveis:

```text
x://object/blake3:<hash>
x://session/<session_id>
x://raw/<raw_record_id>
```

Se exportar para filesystem, resolva para caminhos relativos:

```text
artifacts/blake3-abcd.txt
raw/source-codex-line-123.json
```

### Recortes de busca

Um recorte deve incluir:

```text
consulta
filtros
hit central
N eventos antes/depois
metadata da sessão
tool call/result relacionado
links para raw records
```

Exemplo:

```markdown
# Search excerpt

Query: `"phpstan" tool:shell is_error:true`
Project: `/Users/.../sites`
Range: 2026-04-01..2026-05-03

## Hit 1

Session: ...
Context:
- User asked ...
- Assistant ran `just analyze`
- Tool result exit code 1
- Error preview ...
```

Regra crítica: se a timeline for incerta, diga no Markdown:

```markdown
Timeline confidence: low. Cursor order inferred from extracted blobs, not canonical protobuf state.
```

---

## 10. Plano de implementação

### MVP em etapas

#### Etapa 1: bundle + schema + CAS

Construa:

```text
x-store init
x.sqlite schema
objects/ content-addressed
source_files
raw_records
import_batches
import_errors
```

Implemente BLAKE3 + zstd desde o início. Não deixe dedup para depois; mudar isso depois é doloroso.

#### Etapa 2: importadores JSON primeiro

Comece por Codex, Claude e Gemini. Eles dão mais retorno com menos reverse engineering.

Ordem sugerida:

```text
1. Codex JSONL
2. Claude JSONL + tool-results
3. Gemini session JSON + logs
4. Cursor meta + blobs JSON + raw protobuf
```

Cursor entra no MVP, mas com timeline parcial. Isso é aceitável se você for honesto no schema.

#### Etapa 3: normalização mínima

Implemente:

```text
sessions
events
messages
content_blocks
tool_calls
tool_results
artifacts
edges
```

Não tente acertar todos os subtipos no primeiro passe. O que importa é preservar raw e gerar entidades principais.

#### Etapa 4: busca

Implemente:

```text
search_docs
FTS5
filtros por data, projeto, tool, modelo, role, erro
```

Esse é o primeiro ponto em que X vira útil.

#### Etapa 5: timeline e Markdown

Implemente:

```text
timeline_items
export session markdown
export search excerpt markdown
```

Não invista em UI antes de ter timeline/export bons.

#### Etapa 6: reimportação idempotente

Teste repetindo a mesma importação 10 vezes. O total de objetos e entidades não deve crescer indevidamente.

#### Etapa 7: Parquet/DuckDB

Gere snapshots:

```text
x export parquet
x query duckdb
```

Isso destrava análise posterior sem complicar o core.

#### Etapa 8: search avançado opcional

Se FTS5 ficar limitado:

```text
x index tantivy
```

Mas não comece por aí. Um índice de busca separado aumenta complexidade operacional.

### O que deixar para depois

Deixe para depois:

```text
embeddings/vetores
UI complexa
sincronização cloud
edição manual de sessões
deduplicação semântica avançada
decodificação completa de protobuf Cursor
classificação automática de todos os tool result shapes
```

### Riscos técnicos

O maior risco é **normalização semântica errada**. Exemplo: tratar `Claude type=system` como system prompt seria bug sério.

O segundo risco é **outputs grandes destruírem o índice**. Se você indexar tudo sem limite, FTS incha e fica lento. Use chunking, previews e artifacts.

O terceiro risco é **Cursor**. Sem `.proto`, você terá recuperação parcial. Isso não bloqueia X, mas bloqueia timeline fiel do Cursor.

O quarto risco é **idempotência em arquivos mutáveis**. Gemini e sessões ativas podem mudar. Você precisa snapshot semantics.

O quinto risco é **privacidade local**. Esses stores têm comandos, paths, código, prompts, outputs e possíveis segredos. Mesmo local-first, X deve ter opção de excluir/mascarar certos paths ou tipos de artifact antes de exportar.

### Testes necessários

Eu exigiria estes testes antes de confiar na ferramenta:

```text
golden fixtures dos quatro formatos
importação repetida idempotente
raw roundtrip: raw_record -> bytes originais
contagens de mensagens/tool_calls por fixture
tool_call/result matching
subagent parent matching
Cursor JSON blob extraction sem timeline falsa
Gemini duplicate sessionId
Claude sessions-index incompleto
Codex legacy top-level function_call/message
large tool output em artifact
FTS rebuild do zero
Parquet export comparado com SQLite counts
Markdown snapshot tests
timezone/timestamp parsing
arquivo corrompido/JSON inválido
```

---

## 11. Críticas à sua ideia

A ideia é boa, mas tem três armadilhas.

Primeira: **“formato canônico” pode virar perda de informação disfarçada**. Se você tentar comprimir tudo em `messages(role, text)`, você vai perder tool calls, outputs, subagentes, progress events, compactações, branches, cwd, artifacts e provenance. X precisa ser mais parecido com um grafo de eventos do que com um transcript.

Segunda: **Cursor vai te frustrar**. O relatório mostra que busca textual em blobs JSON é viável, mas timeline fiel depende do protobuf/root state. Você deve aceitar duas fases: importação parcial agora, decodificação melhor depois. Não prenda o projeto tentando resolver Cursor perfeitamente no início.

Terceira: **Parquet parece tentador, mas é a ferramenta errada como fonte da verdade**. Ele é excelente para analytics; é ruim para raw preservation, reimportação incremental, full-text, edge graph e pequenos upserts. Use Parquet como export derivado.

A decisão que mais pode te prender no futuro é escolher uma tecnologia de storage “esperta” demais cedo demais. RocksDB/LMDB, Protobuf, FlatBuffers, LanceDB e uma busca vetorial completa parecem sofisticados, mas empurram você para um sistema menos inspecionável. Para o que você quer — local-first, auditável, reprocessável, portátil — **SQLite + CAS + FTS5 + Parquet derivado** é mais forte.

Tecnologias que eu usaria hoje:

```text
Rust ou Go para CLI/importadores
SQLite para catálogo/projeções
SQLite FTS5 para busca MVP
BLAKE3 para object ids
Zstandard para compressão
DuckDB para analytics
Parquet/Arrow para exports derivados
Tantivy apenas quando FTS5 virar gargalo real
```

Tecnologias que eu evitaria como core:

```text
DuckDB como fonte canônica única
Parquet como event store principal
RocksDB/LMDB para o catálogo
Protobuf/FlatBuffers como formato canônico humano
LanceDB/vector DB como pilar inicial
JSONL comprimido como único formato consultável
um único SQLite com todos os blobs gigantes dentro
```

A alternativa mais simples que eu consideraria, se você quiser reduzir escopo, é: **não criar “formato X completo” no início**. Crie primeiro um **indexador local**:

```text
raw preservation
sessions/messages/tool_calls/tool_results/events
FTS
Markdown export
```

Sem Parquet, sem embeddings, sem UI complexa. Depois que os importadores estiverem corretos, X vira naturalmente o formato canônico. Esse caminho é menos glamouroso, mas é o que tem mais chance de virar ferramenta real.

[1]: https://duckdb.org/docs/current/guides/file_formats/query_parquet.html?utm_source=chatgpt.com "Querying Parquet Files"
[2]: https://www.sqlite.org/fts5.html?utm_source=chatgpt.com "SQLite FTS5 Extension"
[3]: https://github.com/BLAKE3-team/BLAKE3?utm_source=chatgpt.com "the official Rust and C implementations of the BLAKE3 ..."
[4]: https://facebook.github.io/zstd/zstd_manual.html?utm_source=chatgpt.com "zstd 1.5.1 Manual"
[5]: https://duckdb.org/docs/current/data/parquet/overview.html?utm_source=chatgpt.com "Reading and Writing Parquet Files"
[6]: https://arrow.apache.org/docs/format/Columnar.html?utm_source=chatgpt.com "Arrow Columnar Format — Apache Arrow v24.0.0"
[7]: https://github.com/quickwit-oss/tantivy?utm_source=chatgpt.com "Tantivy is a full-text search engine library inspired ..."
