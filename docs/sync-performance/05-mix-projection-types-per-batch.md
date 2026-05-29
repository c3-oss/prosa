# 05 — Empacotar múltiplos tipos de projeção (e CAS objects) no mesmo batch

> Status: Pending — tracked in [ROADMAP.md](../../ROADMAP.md#sync-performance). Siblings #01, #02, #04, #06, #08 e #09 já entregues (PRs #37–#47); ver git history.

**Tier**: 2 · **Onde**: cliente · **Impacto estimado**: 281 → ~167 batches (-40%) ou menos · **Esforço**: S

## Fact-check 2026-05-16

**Veredicto**: ideia válida, proposta não pronta. O protocolo já aceita objetos
CAS e projeções juntos, e o caminho single-batch já faz isso. O chunked atual
separa CAS e depois promove tipos de projeção em fases. O documento, porém,
está desatualizado e ignora dependências entre tipos quando pais e filhos caem
em batches diferentes.

**Correções obrigatórias**:

- O código atual tem **6 tipos de projeção**, não 4: `sourceFiles`,
  `rawRecords`, `sessions`, `searchDocs`, `toolCalls`, `toolResults`.
- Packing precisa ser topológico entre batches: `sourceFiles -> rawRecords`,
  `sessions -> searchDocs/toolCalls`, `toolCalls -> toolResults`, e objetos CAS
  antes das projeções que os referenciam.
- Dentro de uma mesma transação as FKs deferrable reduzem o problema; entre
  batches, filho antes de pai falha ou fica invisível até o pai existir.
- Recalcular impacto com `totalRows` incluindo tool calls/results e com limite
  de `bodyLimit` do Fastify.

## Resumo

A CLI hoje envia **um único tipo de projeção por batch**: sourceFiles,
rawRecords, sessions, searchDocs, toolCalls e toolResults. Cada tipo é dividido
por `ceil(count / maxRowsPerCommit)`. Como o `commitUpload` no servidor já aceita
um `ProjectionPayload` contendo os 6 tipos misturados, é possível empacotar tipos
compatíveis no mesmo commit e, quando seguro, junto dos CAS objects. O packer
não pode ser apenas greedy: ele precisa respeitar dependências entre tipos.

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:442-461`

```ts
await promoteProjectionChunks(
  'source-file',
  (cursor, limit) => readSourceFileChunk(bundle, cursor, limit),
  (sourceFiles) => ({ ...emptyProjection(), sourceFiles }),
)
await promoteProjectionChunks(
  'raw-record',
  (cursor, limit) => readRawRecordChunk(bundle, cursor, limit),
  (rawRecords) => ({ ...emptyProjection(), rawRecords }),
)
await promoteProjectionChunks(
  'session',
  ...
)
await promoteProjectionChunks(
  'search-doc',
  ...
)
```

`apps/cli/src/cli/sync/limits.ts:75-83`

```ts
export function estimateChunkedUploadBatches(counts: UploadCounts, limits: SyncLimits): number {
  return (
    Math.ceil(counts.casObjects / limits.maxObjectsPerPlan) +
    Math.ceil(counts.sourceFiles / limits.maxRowsPerCommit) +
    Math.ceil(counts.rawRecords / limits.maxRowsPerCommit) +
    Math.ceil(counts.sessions / limits.maxRowsPerCommit) +
    Math.ceil(counts.searchDocs / limits.maxRowsPerCommit)
  )
}
```

Para o `~/.prosa` do memo:

| Tipo          | Count    | Batches (limit=10k) |
| ------------- | -------- | ------------------- |
| sourceFiles   | 3 173    | 1                   |
| rawRecords    | 811 511  | 82                  |
| sessions      | 3 141    | 1                   |
| searchDocs    | 291 498  | 30                  |
| **Projeção**  | 1,1 M    | **114 batches**     |
| casObjects    | 834 333  | **167 batches**     |
| **Total**     |          | **281 batches**     |

Se misturarmos todos os tipos de projeção no mesmo batch, o limite inferior é
`ceil(totalRowsIncluindoTools / 10 000)`. Para os números antigos sem
toolCalls/toolResults, isso seria `ceil(1 109 323 / 10 000) = 111` batches
(-3 vs 114). Com o schema atual, é preciso recalcular incluindo tools.

**Se também misturarmos CAS com projeção**: 167 batches CAS-bound dominam — projeção entra "de carona" até saturar `maxRowsPerCommit`. **Total: 167 batches** (-40 %).

## Mudança proposta

### (a) Empacotador unificado

Trocar as chamadas separadas + o loop CAS por um único orquestrador que mantém
7 cursores (1 CAS + 6 projeção) e produz batches saturando os limites, desde que
respeite a ordem topológica entre tipos.

```ts
type CursorState = {
  object: string | null
  sourceFile: string | null
  rawRecord: string | null
  session: string | null
  searchDoc: string | null
  done: { object: boolean; sourceFile: boolean; rawRecord: boolean; session: boolean; searchDoc: boolean }
}

async function packNextBatch(
  bundle: Bundle, storePath: string, state: CursorState,
  maxObjects: number, maxRows: number,
): Promise<{ casObjects: LocalCasObjectChunk[]; projection: ProjectionPayload; state: CursorState } | null> {
  // 1) Drain CAS up to maxObjects
  const cas = !state.done.object
    ? await readObjectChunk(bundle, storePath, state.object, maxObjects)
    : { casObjects: [], nextCursor: state.object }

  // 2) Fill projection slot (maxRows) preferring tipos com mais backlog
  const remaining = maxRows
  const projection: ProjectionPayload = emptyProjection()
  // greedy: sources primeiro (FK), depois rawRecords, sessions, searchDocs
  for (const kind of ['sourceFile', 'session', 'rawRecord', 'searchDoc'] as const) {
    if (state.done[kind]) continue
    const slot = remaining - projectionRowCount(projection)
    if (slot <= 0) break
    const chunk = readChunkForKind(bundle, kind, state[kind], slot)
    appendToProjection(projection, kind, chunk.rows)
    state[kind] = chunk.nextCursor
    if (chunk.rows.length < slot) state.done[kind] = true
  }

  state.object = cas.nextCursor
  if (cas.casObjects.length < maxObjects) state.done.object = true

  if (cas.casObjects.length === 0 && projectionRowCount(projection) === 0) return null
  return { casObjects: cas.casObjects, projection, state }
}
```

### (b) Ordem de FK respeitada

`sourceFile` deve preceder `rawRecord`; `session` deve preceder `searchDoc` e
`toolCall`; `toolCall` deve preceder `toolResult`. Como o `commitUpload` aceita
os 6 tipos juntos em uma única transação, o `insertProjectionRows` consegue
inserir em ordem dentro do batch. O problema é entre batches: se um batch contém
filhos de pais ainda não promovidos/verificados, a promoção pode falhar.

### (c) Single-batch mode reusa o packer

Quando `uploadLimitViolations.length === 0`, o packer só produz 1 batch — caminho idêntico ao `promoteUpload` atual mas com a vantagem de unificar a lógica.

## Impacto esperado

| Cenário                        | Batches | Round-trips (4 por batch) |
| ------------------------------ | ------- | ------------------------- |
| Hoje (tipos separados; número antigo sem tools) | 281 | 1 124 |
| Só mix de tipos de projeção    | 278     | 1 112                     |
| Mix CAS + projeção             | **167** | **668**                   |

Combinado com #03 (paralelismo cliente, pool=6): 167 / 6 ≈ **28 ondas**. Ganho composto de ~10× sobre baseline serial.

## Riscos e armadilhas

- **`estimateChunkedUploadBatches`** precisa ser reescrito para refletir a nova lógica de packing — ou ser apenas um "máximo otimista" que serve para o dry-run.
- **Cursors agora compartilhados**: se o sync for interrompido no meio, retomar exige cursors do *batch* (não por tipo) — ver #08.
- **Limites server-side** continuam válidos: `maxObjectsPerPlan=5000` e `maxRowsPerCommit=10000` aplicados pelo packer, sem mudança de protocolo.
- **Manifest hash do batch**: o servidor calcula `buildManifestHash` (`manifest.ts:141-163`) sobre objetos + projeção combinada — já é tipo-agnóstico, então mix não muda o hash.

## Como validar

1. **Teste E2E**: `pnpm dev -- v1 sync` contra fixture com 5 sessions + 50 rawRecords + 10 CAS objects → deve gerar 1 batch, não 4.
2. **Bench**: contar batches gerados para `~/.prosa` antes/depois (`--verbose | grep 'plan ' | wc -l`).
3. **Integridade**: `prosa v1 analytics sessions` pós-sync deve mostrar todas as 3 141 sessions e cross-checks de FK.

## Dependências e ordem

- **Independente** de #01, #02, #04. Pode ir junto com #03 (que reescreve o loop de qualquer jeito).
- **Cuidado com #08** (checkpoint): a granularidade muda — cursors precisam ser por batch.

## Prior art

- Sentry chunk endpoint: aceita multiple kinds de "chunk" no mesmo upload, cap por bytes ([chunk.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/chunk.py)).
- Git packfile: contém commits, trees, blobs misturados num único transfer ([packfiles chapter](https://git-scm.com/book/en/v2/Git-Internals-Packfiles)).
