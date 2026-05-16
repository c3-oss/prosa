# 06 — Subir `OBJECT_UPLOAD_CONCURRENCY` 16 → 32 e expor flag

**Tier**: 2 · **Onde**: cliente · **Impacto estimado**: 1.5–2× na fase de bytes (quando há missing objects) · **Esforço**: XS (~5 LoC + flag)

## Resumo

Concorrência de upload de bytes está hardcoded em 16 em `apps/cli/src/cli/commands/sync.ts:92`. Benchmarks públicos (S3, MinIO, Backblaze B2) consistentemente mostram que 32–64 é o sweet-spot para uploads pequenos; 16 é conservador. Bumpar para 32 default e expor `--object-concurrency <N>` permite tuning sem custo arquitetural.

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:92`

```ts
const OBJECT_UPLOAD_CONCURRENCY = 16
```

Aplicado em `apps/cli/src/cli/commands/sync.ts:353`:

```ts
await mapConcurrent(missingObjects, OBJECT_UPLOAD_CONCURRENCY, async ({ entry: obj, bytes }) => {
  await client.uploadObjectBytes({ ... })
})
```

E nas mesmas linhas em `apps/cli/src/cli/sync/promotion.ts` (que **nem usa** `mapConcurrent` — está em loop `for...of` sequencial). Esta inconsistência também precisa ser corrigida.

## Mudança proposta

### (a) Default → 32

```ts
// apps/cli/src/cli/commands/sync.ts:92
const DEFAULT_OBJECT_UPLOAD_CONCURRENCY = 32
```

### (b) Flag CLI

```ts
.option(
  '--object-concurrency <n>',
  'concurrent CAS uploads per batch (default: 32; range 1-128)',
  (v) => {
    const n = Number.parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1 || n > 128) throw new CliUserError('--object-concurrency must be 1-128')
    return n
  },
  DEFAULT_OBJECT_UPLOAD_CONCURRENCY,
)
```

Propagar para `promoteChunkedUpload` e `promoteUpload` via `objectConcurrency` option.

### (c) Single-batch também usa `mapConcurrent`

`apps/cli/src/cli/sync/promotion.ts:~44` provavelmente tem o loop sequencial:

```ts
for (const obj of missingObjects) {
  await client.uploadObjectBytes({ ... })  // ← sequencial!
}
```

Trocar por `mapConcurrent(missingObjects, objectConcurrency, ...)` — alinha comportamento entre `chunked` e `single-batch`.

### (d) Variável de ambiente como fallback

```ts
const envConcurrency = Number(process.env.PROSA_OBJECT_CONCURRENCY)
const concurrency = options.objectConcurrency
  ?? (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : DEFAULT_OBJECT_UPLOAD_CONCURRENCY)
```

## Impacto esperado

Cenário: 100 000 CAS objects faltantes, ~10 KB cada, contra MinIO local (latência ~1 ms, throughput ~1 GB/s):

| Concorrência | RTTs por onda | Ondas | Tempo total estimado |
| ------------ | ------------- | ----- | -------------------- |
| 16           | ~3 ms         | 6 250 | ~18 s                |
| 32           | ~3 ms         | 3 125 | ~9 s                 |
| 64           | ~4 ms         | 1 562 | ~6 s                 |
| 128          | ~6 ms         | 781   | ~5 s (curva achata)  |

**Cuidado**: para o sintoma do memo, a maioria dos batches reportou `missingObjects=0`. Essa otimização só vale quando há bytes para subir — é cara em situações reais de sync inicial, irrelevante em re-syncs.

## Riscos e armadilhas

- **Fastify connection-backlog**: o API server proxia os PUTs (não há presigned URL — ver #07). Validar com `fastify --listen 0.0.0.0:N --maxConnections N` se o default cobre 32+.
- **HTTP keep-alive**: o `ProsaApiClient` (`apps/cli/src/cli/auth/client.ts`) precisa ter pool de conexões habilitado (undici `Pool` ou Node fetch com keep-alive). Verificar; se não, ganho de conc=32 será comido por TCP handshake.
- **MinIO local**: tem default `MINIO_API_REQUESTS_MAX` (~1024 simultâneos); 32 é seguro.
- **Compartilhamento com #03**: se #03 levantar pool de batches a 6, concorrência total fica 6 × 32 = 192 PUTs simultâneos. Documentar o produto.
- **Memória**: cada upload mantém o buffer em RAM. 32 × ~10 KB = 320 KB — irrelevante. Para objetos grandes (até 256 MB), 32 paralelos = 8 GB worst-case — flag deve permitir baixar.

## Como validar

1. **Bench dedicado**: subir 10 000 CAS objects sintéticos de ~10 KB com `--object-concurrency=8/16/32/64/128`, medir tempo total. Curva esperada: linear até ~32, achatamento.
2. **Validar pool HTTP**: capturar `tcpdump` do client; deve haver << 32 SYN/handshakes na fase de upload.
3. **MinIO metrics**: `minio --console-address` → ver `s3_requests_total` per second.

## Dependências e ordem

- **Independente** de tudo. Pode ir em uma PR de "tuning" junto com #04.
- **Sinergético com #03** (paralelismo de batches) — atenção ao produto total.

## Prior art

- Rasmussen S3 benchmark: peak ~64 threads, plateau ~128 ([improve.dk/pushing-the-limits-of-amazon-s3-upload-performance](https://improve.dk/pushing-the-limits-of-amazon-s3-upload-performance/)).
- AWS S3 performance guidelines: 32–128 parallel ops ([docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html)).
- MinIO Warp default `multipart-put` concurrency = 32 ([docs.min.io/enterprise/minio-warp](https://docs.min.io/enterprise/minio-warp/reference/cli/multipart-put/)).
- Sentry chunk uploader: 8 workers em produção (mais conservador porque os chunks são MB-sized) ([chunk-upload.py](https://github.com/getsentry/sentry-cli/blob/master/src/utils/chunks/upload.rs)).
