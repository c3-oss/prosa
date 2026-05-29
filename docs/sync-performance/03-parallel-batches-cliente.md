# 03 — Paralelizar batches no cliente (`pLimit(N)` sobre o loop principal)

> Status: Pending — tracked in [ROADMAP.md](../../ROADMAP.md#sync-performance). Siblings #01, #02, #04, #06, #08 e #09 já entregues (PRs #37–#47); ver git history.

**Tier**: 1 (depois de #01 e #02) · **Onde**: cliente · **Impacto estimado**: 4–8× no tempo total · **Esforço**: S (estrutural mas localizado)

## Fact-check 2026-05-16

**Veredicto**: parcialmente viável, mas não pronta. O loop serial existe, porém
paralelizar batches sem mudar a semântica de recibo/autoridade remota pode
deixar o estado final não determinístico.

**Correções obrigatórias**:

- O código atual promove CAS e depois **6** fases de projeção, não 4.
- A estimativa de “4 RTTs por batch” é imprecisa: com `missingObjects=0` não há
  PUT; com objetos faltantes há muitos PUTs concorrentes.
- `verifyPromotion` produz receipt **por batch** e `remote_authority` é
  sobrescrito a cada batch verificado. Com batches paralelos, “último a
  terminar” pode ser um batch pequeno ou CAS-only.
- Repetir `commitUpload` no mesmo batch já committed retorna 412. Idempotency
  key/checkpoint são pré-requisitos práticos para retries robustos.
- `readObjectChunk` lê bytes e recalcula hashes; paralelizar leitura local
  também aumenta I/O, CPU e memória. Limite por bytes-em-voo é necessário.

## Resumo

O loop em `promoteChunkedUpload` é estritamente sequencial: nenhum batch começa antes do anterior verificar o receipt. Com #01 e #02 reduzindo o custo por batch no servidor, o gargalo pode passar a ser a latência fixa por batch. Paralelizar batches é promissor, mas deve vir depois de: bulk/idempotência no servidor, política de receipt agregado para chunked sync e limites de bytes/conexões em voo.

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:390-461`

```ts
async function promoteChunkedUpload(...): Promise<SyncResult> {
  let batchCount = 0
  let lastReceipt: PromotionReceipt | null = null
  let objectCursor: string | null = null

  while (true) {                                        // ← serial
    const chunk = await readObjectChunk(...)
    if (chunk.casObjects.length === 0) break
    batchCount += 1
    lastReceipt = await promoteChunk({ ... })           // ← await bloqueia próximo batch
    objectCursor = chunk.nextCursor
  }

  const promoteProjectionChunks = async <TRow>(...) => {
    let cursor: string | null = null
    while (true) {                                      // ← também serial
      const chunk = readChunk(cursor, maxRowsPerCommit)
      if (chunk.rows.length === 0) break
      batchCount += 1
      lastReceipt = await promoteChunk({ ... })
      cursor = chunk.nextCursor
    }
  }
  // 6 chamadas seriais a promoteProjectionChunks no código atual
}
```

Cada `promoteChunk` faz 4 RTTs HTTP: `planUpload` → uploads de bytes → `commitUpload` → `verifyPromotion`. Com latência local de 5–20 ms por RTT, cada batch sem bytes para subir ainda gasta ~30–100 ms só em round-trips. × 281 batches = 8–30 s desperdiçados em latência fixa.

## Mudança proposta

### Estratégia: pré-paginação de cursores + worker pool

O obstáculo da paralelização é que `nextCursor` só é conhecido após ler o chunk. Solução: ler todos os cursors antes (pagination em SQLite é barata) e despachar para um pool.

```ts
// 1) Coleta todos os ranges de antemão (SQLite local, microssegundos):
function collectObjectBatchCursors(bundle: Bundle, batchSize: number): Array<{ from: string | null; to: string }> {
  // SELECT objects ordered by object_id, agrupando em janelas de batchSize
  // Retorna pares (firstId, lastId) por batch
}

// 2) Worker pool sobre os ranges:
const BATCH_CONCURRENCY = 6
const ranges = collectObjectBatchCursors(bundle, maxObjectsPerPlan)

await pMapBounded(ranges, BATCH_CONCURRENCY, async (range, idx) => {
  const chunk = await readObjectChunkByRange(bundle, storePath, range)
  await promoteChunk({
    client, deviceId, storePath,
    casObjects: chunk.casObjects,
    projection: emptyProjection(),
    label: `object batch ${idx + 1}/${ranges.length}`,
    verbose,
  })
})

// 3) Mesma estratégia para sourceFiles, rawRecords, sessions, searchDocs.
```

### Estratégia alternativa: stripes por hash prefix

Mais simples se a pré-paginação for chata: dividir CAS objects por prefixo de hash em N stripes (e.g., `object_id LIKE '0%'`, `'1%'`, ...). Cada stripe roda seu próprio cursor serial em paralelo. Custo: distribuição pode ser desigual; ganho: zero acoplamento de paginação.

### Tamanho do pool

- **CAS batches**: 6–8. Cada batch faz uploads de bytes em paralelo internamente (conc. 16, ou 32 após #06) — não queremos saturar com 8 × 32 = 256 conexões.
- **Projection batches**: 4–6. Custo dominado por SQL no Postgres; 4 transações concorrentes é seguro.
- **Tunável via flag**: `--batch-concurrency <N>` com default conservador.

## Impacto esperado

| Métrica                             | Antes               | Depois (pool=6)       | Ganho |
| ----------------------------------- | ------------------- | --------------------- | ----- |
| Batches seriais                     | 281                 | 281/6 ≈ 47 ondas      | ~6×   |
| Tempo total (RTT-bound após #01/#02) | proporcional a 281 | proporcional a 47     | ~6×   |
| Connections HTTP concorrentes       | 1 (+16 uploads)     | 6 (+ até 6×32 uploads) | —     |

## Riscos e armadilhas

- **Deadlocks/races PG entre batches concorrentes**: dois batches contendo o
  mesmo `object_id` podem chamar `insertRemoteObjectIfMissing` em paralelo.
  Mitigação: #02 precisa eliminar o `SELECT -> INSERT` com bulk idempotente e
  checagem de conflito pós-insert. Por isso #03 só faz sentido após #02.
- **Ordem de verify / `remote_authority`**: o sync atual usa recibos por batch.
  Com paralelismo, "último" perde sentido e "qualquer receipt" não é suficiente:
  `verifyPromotion` valida apenas o manifesto daquele batch. É preciso serializar
  a etapa final que grava `remote_authority` ou criar um receipt agregado de
  sync chunked completo.
- **`recordPromotion` no CliConfig**: hoje só single-batch grava receipt em config. Manter esse comportamento (chunked não grava) ou consolidar uma vez no fim, tanto faz para paralelização.
- **MinIO / object store**: 6 × 32 = 192 PUTs simultâneos pode estourar `--http-max-streams` em alguns S3 endpoints. Local OK. Documentar no `--help`.
- **Memória**: cada batch carrega `casObjects.bytes` em RAM. 6 batches × 5000 objetos × ~kB médios = ~30 MB — confortável. Cuidado se os objetos forem grandes; aplicar throttle por bytes-em-flight.
- **Tracking de progresso**: log "plan batch 5/281" precisa virar "plan batch N (6 em flight, 47 concluídos)". Ver item #10.

## Como validar

1. **Bench A/B com `~/.prosa`**: medir wall-clock total com pool=1 vs pool=2/4/6/8. Espera-se sublinear scaling pico em pool=6.
2. **Integridade**: rodar `prosa v1 sync` em paralelo e depois `prosa v1 analytics sessions` — todas as 3 141 sessions devem aparecer.
3. **Stress**: rodar 2 syncs concorrentes do mesmo store para validar idempotência sob concorrência (também ajuda em #09).
4. **PG locks**: monitorar `pg_stat_activity` durante o sync — não pode haver waits longos.

## Dependências e ordem

- **Bloqueado por #02** (sem ele, batches paralelos amplificam contenção SELECT+INSERT no PG).
- **Sinergético com #01** (HEAD em paralelo no servidor reduz a fase mais lenta de cada batch).
- **Considere combinar com #06** (subir concorrência de upload de bytes) — mas só aumente um vetor por vez ao medir.

## Prior art

- Padrão `pLimit` / `mapConcurrent` é universal em clients HTTP de bulk (já usado em `sync.ts:101-117` para uploads intra-batch).
- AWS S3 multipart upload e MinIO Warp: 32–128 concurrent ops é o sweet-spot ([improve.dk/pushing-the-limits-of-amazon-s3-upload-performance](https://improve.dk/pushing-the-limits-of-amazon-s3-upload-performance/)).
- restic PR #3489 (async pack uploads): explicitamente 1 pack em flight inicialmente; estudo posterior subiu para N — análoga à transição que estamos fazendo aqui ([github.com/restic/restic/pull/3489](https://github.com/restic/restic/pull/3489)).
