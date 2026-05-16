# 05 — Empacotar múltiplos tipos de projeção (e CAS objects) no mesmo batch

**Tier**: 2 · **Onde**: cliente · **Impacto estimado**: 281 → ~167 batches (-40%) ou menos · **Esforço**: S

## Resumo

A CLI hoje envia **um único tipo de projeção por batch**: 4 chamadas seriais a `promoteProjectionChunks` (sourceFiles, rawRecords, sessions, searchDocs). Cada tipo é dividido por `ceil(count / maxRowsPerCommit)`. Resultado: rounding-up multiplicado por 4. Como o `commitUpload` no servidor já aceita um `ProjectionPayload` contendo os 4 tipos misturados, basta empacotar até `maxRowsPerCommit` rows independentemente do tipo — **e**, melhor ainda, **dentro do mesmo batch que envia CAS objects**, em vez de ter fases CAS-only seguidas de projection-only.

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

Se misturarmos os 4 tipos no mesmo batch: `ceil(1 109 323 / 10 000) = 111` batches (-3 vs 114). Modesto.

**Se também misturarmos CAS com projeção**: 167 batches CAS-bound dominam — projeção entra "de carona" até saturar `maxRowsPerCommit`. **Total: 167 batches** (-40 %).

## Mudança proposta

### (a) Empacotador unificado

Trocar as 4 chamadas separadas + o loop CAS por um único orquestrador que mantém 5 cursores (1 CAS + 4 projeção) e produz batches saturando os limites em paralelo.

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

`sourceFile` deve preceder `rawRecord` (FK `raw_record.source_file_id`). Como o `commitUpload` aceita os 4 tipos juntos em uma única transação, o `insertProjectionRows` precisa apenas inserir na ordem correta — `apps/api/src/trpc/routers/sync/projection-upserts.ts:251-292` já faz **sessions → sourceFiles → rawRecords → searchDocs** dentro de uma única transação. ✅

### (c) Single-batch mode reusa o packer

Quando `uploadLimitViolations.length === 0`, o packer só produz 1 batch — caminho idêntico ao `promoteUpload` atual mas com a vantagem de unificar a lógica.

## Impacto esperado

| Cenário                        | Batches | Round-trips (4 por batch) |
| ------------------------------ | ------- | ------------------------- |
| Hoje (4 tipos separados)       | 281     | 1 124                     |
| Só mix de tipos de projeção    | 278     | 1 112                     |
| Mix CAS + projeção             | **167** | **668**                   |

Combinado com #03 (paralelismo cliente, pool=6): 167 / 6 ≈ **28 ondas**. Ganho composto de ~10× sobre baseline serial.

## Riscos e armadilhas

- **`estimateChunkedUploadBatches`** precisa ser reescrito para refletir a nova lógica de packing — ou ser apenas um "máximo otimista" que serve para o dry-run.
- **Cursors agora compartilhados**: se o sync for interrompido no meio, retomar exige cursors do *batch* (não por tipo) — ver #08.
- **Limites server-side** continuam válidos: `maxObjectsPerPlan=5000` e `maxRowsPerCommit=10000` aplicados pelo packer, sem mudança de protocolo.
- **Manifest hash do batch**: o servidor calcula `buildManifestHash` (`manifest.ts:141-163`) sobre objetos + projeção combinada — já é tipo-agnóstico, então mix não muda o hash.

## Como validar

1. **Teste E2E**: `pnpm dev -- sync` contra fixture com 5 sessions + 50 rawRecords + 10 CAS objects → deve gerar 1 batch, não 4.
2. **Bench**: contar batches gerados para `~/.prosa` antes/depois (`--verbose | grep 'plan ' | wc -l`).
3. **Integridade**: `prosa analytics sessions` pós-sync deve mostrar todas as 3 141 sessions e cross-checks de FK.

## Dependências e ordem

- **Independente** de #01, #02, #04. Pode ir junto com #03 (que reescreve o loop de qualquer jeito).
- **Cuidado com #08** (checkpoint): a granularidade muda — cursors precisam ser por batch.

## Prior art

- Sentry chunk endpoint: aceita multiple kinds de "chunk" no mesmo upload, cap por bytes ([chunk.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/chunk.py)).
- Git packfile: contém commits, trees, blobs misturados num único transfer ([packfiles chapter](https://git-scm.com/book/en/v2/Git-Internals-Packfiles)).
