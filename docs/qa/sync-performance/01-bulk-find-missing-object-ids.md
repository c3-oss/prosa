# 01 — Bulk-ify `findMissingObjectIds` (1 SELECT + HEADs concorrentes)

**Tier**: 1 (maior alavanca) · **Onde**: servidor · **Impacto estimado**: 30–60× em `findMissingObjectIds`, não no `planUpload` inteiro · **Esforço**: XS-S

## Fact-check 2026-05-16

**Veredicto**: parcialmente válida. O gargalo existe em
`apps/api/src/trpc/routers/sync/manifest.ts:216`: hoje a função faz um
`SELECT remote_object` e um `objectStore.head()` por objeto, em série.

**Correções de escopo**:

- Esta mudança acelera `findMissingObjectIds`, mas não bulkifica o `planUpload`
  inteiro. Antes dela, `planUpload` ainda roda `assertRemoteObjectCatalog` e
  `INSERT sync_batch_object_manifest` por objeto.
- Manter o `SELECT` em `remote_object`, sem join em `tenant_object`, preserva a
  semântica atual de dedupe global de CAS. O grant do tenant continua sendo
  criado no `commitUpload`.
- `HEAD_CONCURRENCY=32` é razoável como ponto de partida, mas precisa benchmark
  com MinIO/S3 e deve ser limitado, não `Promise.all` aberto.
- Testes mínimos: entrada vazia, ordem estável de `missingObjectIds`, catálogo
  ausente, blob ausente, hash/size drift e objeto global existente sem
  `tenant_object` do tenant atual.

## Resumo

`findMissingObjectIds` faz 2 round-trips seriais por objeto (1 SELECT Postgres + 1 `objectStore.head()`). Para o `~/.prosa` do memo são 5000 objetos × 2 = 10 000 round-trips por plan, em 167 plans só para CAS — mais de **1,6 milhão de round-trips seriais** apenas para descobrir o que falta. Trocar por **1 SELECT bulk** + **HEADs paralelos limitados** reduz drasticamente essa função específica. O `planUpload` completo ainda precisa de otimizações separadas para o loop de manifesto/catálogo.

## Diagnóstico atual

`apps/api/src/trpc/routers/sync/manifest.ts:216-238`

```ts
export async function findMissingObjectIds(opts: {
  rawExec: RawExec
  objectStore: RemoteObjectStore
  objects: ObjectManifestEntry[]
}): Promise<string[]> {
  const missing: string[] = []
  for (const obj of opts.objects) {                          // ← serial
    const storageKey = storageKeyForObject(obj)
    const exists = await opts.rawExec(                       // ← 1 query/objeto
      'SELECT 1 FROM "remote_object" WHERE object_id = $1 LIMIT 1',
      [obj.objectId],
    )
    const head = await opts.objectStore.head(storageKey)     // ← 1 RTT/objeto
    const transportHash = obj.transportHash ?? obj.hash
    if (
      exists.length === 0 ||
      !head ||
      head.hash.toLowerCase() !== transportHash ||
      head.compressedSize !== obj.compressedSize ||
      head.uncompressedSize !== obj.uncompressedSize
    ) {
      missing.push(obj.objectId)
    }
  }
  return missing
}
```

Para `N=5000` objetos com latência local ~1 ms por op: ~10 s por plan apenas neste passo. Multiplicado por ~167 plans CAS: ~28 minutos cumulativos.

## Mudança proposta

Duas etapas independentes, ambas seguras isoladamente:

### (a) Postgres: 1 query com `ANY($1::text[])`

```ts
const objectIds = opts.objects.map((o) => o.objectId)
const existingRows = await opts.rawExec<{ object_id: string }>(
  'SELECT object_id FROM "remote_object" WHERE object_id = ANY($1::text[])',
  [objectIds],
)
const existsSet = new Set(existingRows.map((r) => r.object_id))
```

5000 round-trips Postgres → **1**.

### (b) Object store: HEADs paralelos com cap

```ts
const HEAD_CONCURRENCY = 32
async function pMapBounded<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return results
}

const heads = await pMapBounded(opts.objects, HEAD_CONCURRENCY, async (obj) => {
  return { obj, head: await opts.objectStore.head(storageKeyForObject(obj)) }
})

const missing: string[] = []
for (const { obj, head } of heads) {
  const transportHash = obj.transportHash ?? obj.hash
  if (
    !existsSet.has(obj.objectId) ||
    !head ||
    head.hash.toLowerCase() !== transportHash ||
    head.compressedSize !== obj.compressedSize ||
    head.uncompressedSize !== obj.uncompressedSize
  ) {
    missing.push(obj.objectId)
  }
}
return missing
```

## Impacto esperado

| Métrica                              | Antes              | Depois             | Ganho   |
| ------------------------------------ | ------------------ | ------------------ | ------- |
| Queries Postgres por plan (5k obj)   | 5000               | 1                  | 5000×   |
| Round-trips object store por plan    | 5000 seriais       | 5000 ÷ 32 ≈ 156    | ~32×    |
| Tempo total `findMissingObjectIds`   | ~10 s (lat. 1 ms)  | ~0,2 s             | ~50×    |
| Tempo total fase CAS (167 plans)     | ~28 min            | ~33 s              | ~50×    |

## Riscos e armadilhas

- **`pg-node` parameter array size**: `text[]` com 5000 elementos é seguro (limite prático do protocolo extended é ~16k bound params, mas aqui é **1 param** = 1 array). Sem risco.
- **Connection-pool contention no MinIO/object store**: `head()` é barato; 32 em paralelo é confortável para `S3Client` (default `maxAttempts` e `requestHandler`). Validar limites do `prosa-storage` adapter.
- **Backpressure de log/observabilidade**: se há logging por op, a explosão paralela pode lotar buffers — tirar logs do hot path.
- **Mudança preserva semântica**: o predicado de "missing" é idêntico ao loop atual. Nenhuma regressão funcional esperada.

## Como validar

1. **Benchmark sintético**: criar 5000 ObjectManifestEntries (todos existentes), chamar `findMissingObjectIds` antes/depois, medir wall-clock.
2. **Teste correto**: caso misto (alguns missing, alguns drift de hash/size, alguns ausentes do Postgres mas presentes no store) — confirmar que o conjunto retornado é idêntico ao da implementação serial.
3. **E2E**: rodar `pnpm dev -- sync` contra `~/.prosa` com `--verbose --dry-run=false`; comparar tempo total e timestamp dos primeiros 10 batches.

## Prior art

- Padrão Git smart-HTTP v2 `have`/`want`: batched negotiation, não 1-a-1 ([git-scm.com/docs/protocol-v2](https://git-scm.com/docs/protocol-v2)).
- IPFS Bitswap: HAVE/DONT_HAVE messages em batch ([blog.ipfs.tech/2020-02-14-improved-bitswap](https://blog.ipfs.tech/2020-02-14-improved-bitswap-for-container-distribution/)).
- Sentry chunk endpoint: assemble pergunta o que falta antes de subir bytes ([chunk.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/chunk.py)).
