# REPORT — CLI-2 `prosa sync`

> Mesmo bundle (smoke) e servidor (Docker postgres+minio) usados no API-1 (`20260516T055033Z-api-1/`). O profiling de cliente foi parcialmente coberto pelo CLI-1 (mesmo binário CLI, mesmo patch). A maior parte da informação acionável vem do API-1 (servidor). Este relatório foca em **achados específicos ao cliente** identificados via inspeção de código + dados de pg_stat_statements do co-run.

> **Resultado do run combinado**: 10 000 objetos PUT em 120 s = **83.3 obj/s**. Cliente patchado (sem duplicate-runCli), object-concurrency=16, batch-concurrency=4. Sync foi interrompido por timeout (912k objetos seria 3+ horas).

## Sumário executivo (static + dynamic)

| # | Área | Sintoma esperado | Causa raiz hipotetizada | Impacto estimado | Esforço | Confiança |
|---|------|------------------|--------------------------|------------------|---------|-----------|
| C1 | `bytesForUpload` em serial dentro de `mapConcurrent` | Cada worker concorrente serializa leitura de bytes do CAS antes do upload S3. | `apps/cli/src/cli/commands/sync.ts:903-906`: `await mapConcurrent(missingObjects, objectConcurrency, async (object) => { const bytes = await bytesForUpload(...); await client.uploadObjectBytes(...) })`. Read e upload são **encadeados dentro do mesmo worker**, então leitura ocupa parte do "slot" de concorrência. | aumento de throughput em ~10-30% se separar pipeline de leitura (produtor) do pipeline de upload (consumidor), via queue. | M (refator de `promoteChunk`) | média (depende de medir overlap real) |
| C2 | `mapConcurrent` com contador compartilhado sem atomic | Não é gargalo no caso comum, mas pode causar gap quando workers de tamanho desigual reentram a fila. | `apps/cli/src/cli/sync/concurrency.ts:6-16` usa `let next = 0` lido/escrito sem `Atomics`. JS é single-thread então safe, mas a heurística de "claim work" pode ser melhorada com batching. | descartado como falso positivo após análise — não é problema em JS single-thread. | - | **baixa** (falso positivo provável) |
| C3 | `commitUpload` por chunk em vez de batched | Cada chunk produz um RTT separado de `client.syncCommitUpload(...)`. | `sync.ts:920-931` chama `client.syncCommitUpload` dentro de `promoteChunk`, que é chamado por `promotePhase` (linha 1013+) com `mapConcurrentResults`. Última batch é serial (linha 1020), criando tail. | redução de ~5-10% em wall-time end-to-end (depende de N de chunks). | S (passar de "chunk → commit → next chunk" para "batch dos N commits em 1"). | média |
| C4 | Bundle reader `bundle.ts:49-76` faz subquery correlacionada por sessão | `(SELECT COUNT(*) FROM turns WHERE session_id = s.session_id)` por linha. | Reportado pelo explore — confirma desenho que pode escalar mal. | redução de ~5-10% em wall-time da fase de leitura. | XS (mover COUNT para JOIN com GROUP BY) | alta (pattern visivel) |

## Cenário

```bash
# Pré-requisito: API server rodando (background) e bundle clonado em /tmp.
node --enable-source-maps apps/cli/dist/bin/prosa.js sync \
  --server http://127.0.0.1:30082 \
  --store /tmp/prosa-perf-bundle-20260516T050149Z-smoke \
  --keep-local --object-concurrency 16 --batch-concurrency 4 --json
```

Cliente patchado (sem duplicate-runCli). Output: `bench/perf/results/<ts>-api-1/sync.json` (mesma run da API-1 captura cliente também).

## Hot paths

### C1 — Leitura serial dentro do worker concorrente

**Arquivo**: `apps/cli/src/cli/commands/sync.ts:899-907`

```typescript
await mapConcurrent(missingObjects, objectConcurrency, async (object) => {
  const { entry: obj } = object
  const bytes = await bytesForUpload(storePath, object, metrics)
  await client.uploadObjectBytes({ batchId: plan.batchId, objectId: obj.objectId, ..., bytes })
  metrics.bytesUploaded += bytes.byteLength
})
```

**Problema**: cada worker abre arquivo (`fs.readFile`), espera bytes, depois inicia HTTP upload. Durante o `await fs.readFile`, o slot de concorrência fica ocupado mesmo sem rede ativa. O network upload poderia começar antes da próxima leitura.

**Padrão recomendado** (produtor-consumidor):

- Worker pool de **leitura** (paralelismo ~4-8 baseado em SSD) populando uma fila bounded de `{objectId, bytes}`.
- Worker pool de **upload** (paralelismo objectConcurrency) consumindo da fila.
- `bytes` é flushed da memória após upload (referência liberada).

**Risco**: bound da fila precisa ser dimensionado para não explodir RAM (1000 objetos × 50 KB médios = 50 MB, mas piores casos podem ter objetos de MB).

**Como validar**: `performance.mark` em volta de `readFile` e `uploadObjectBytes`; histograma de delta entre fim da leitura e início do upload. Se overlap atual <30 %, otimização vale.

### C2 — Falso positivo: `mapConcurrent` shared counter

`concurrency.ts:6-16` usa `let next = 0` lido/escrito por workers. **Em JavaScript single-thread, isso é seguro** — workers async são cooperativos, não preemptivos. Não há condição de corrida. **Descartar.**

### C3 — `commitUpload` per-chunk (não batched cross-chunk)

**Arquivo**: `apps/cli/src/cli/commands/sync.ts:920-931`

Cada `promoteChunk` faz um `syncCommitUpload` separado. Se há M chunks paralelos, fazemos M RPC calls. Em conexão local (Docker), latência por chamada é ~10ms RTT + processing. M=20 chunks = ~200ms acumulado mesmo se servidor for instantâneo.

**Padrão recomendado**: agrupar commits de até K chunks em uma chamada `syncCommitUploadBatch` (nova RPC server-side que aceita array de plans).

**Risco**: contradiz design de chunks ser independente; talvez não valha a complexidade.

### C4 — Subquery correlacionada em `readSessionsForUpload`

**Arquivo**: `apps/cli/src/cli/sync/bundle.ts:49-76`

```sql
SELECT s.session_id, ..., 
  (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turn_count
FROM sessions s
WHERE ...
```

Para N sessões, isso são N+1 queries (SQLite pode otimizar, mas pode também serializar). Para 3500 sessões em SQLite local, é OK; mas o pattern é frágil.

**Padrão recomendado**:

```sql
SELECT s.*, COALESCE(tc.cnt, 0) AS turn_count
FROM sessions s
LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM turns GROUP BY session_id) tc ON tc.session_id = s.session_id
WHERE ...
```

**Risco**: muito baixo. Apenas reescrita SQL.

**Como validar**: `EXPLAIN QUERY PLAN` antes/depois. Wall-time da função em hyperfine.

## Falsos positivos descartados

- `mapConcurrent shared counter` (C2 acima).
- `zstd-napi compress` em sync — no client side, a maioria dos objetos já está pré-comprimida em CAS. Compress só roda em casos novos.

## Aceitação para esta seção

- [ ] Sync end-to-end concluído sem erro.
- [ ] `sync.json` registrado com `metrics.{planMs,uploadMs,commitMs,...}` para correlação.
- [ ] Validação de C1 com `performance.mark` em build instrumentada (separada do bundle de prod) — **TODO em iteração futura**.
