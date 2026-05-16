# 07 — Endpoint `POST /objects:bulk` empacotado (pack file streaming)

**Tier**: 3 (maior impacto, maior esforço — só vale após #01/#02) · **Onde**: ambos · **Impacto estimado**: 5–10× na fase de bytes quando há muitos objetos pequenos · **Esforço**: M-L

## Resumo

Hoje cada CAS object faltante vai num **PUT individual** para `/objects/:objectId`. Para um sync inicial de `~/.prosa`, isso pode chegar a centenas de milhares de PUTs. A literatura (Git packfiles, Sentry chunk API, restic pack files) converge em uma resposta: **empacotar N objetos pequenos numa única requisição** colapsa overhead TCP/TLS/HTTP/Fastify. Cap típico: ~64 objetos / ~16 MB por request, com server explodindo internamente em paralelo para o object store.

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:353-364`:

```ts
await mapConcurrent(missingObjects, OBJECT_UPLOAD_CONCURRENCY, async ({ entry: obj, bytes }) => {
  await client.uploadObjectBytes({
    batchId: plan.batchId,
    objectId: obj.objectId,
    hash: obj.hash,
    ...(obj.transportHash ? { transportHash: obj.transportHash } : {}),
    compression: obj.compression,
    compressedSize: obj.compressedSize,
    uncompressedSize: obj.uncompressedSize,
    bytes,
  })
})
```

Cada chamada é um `PUT /objects/<id>?...` separado. Para 834 333 objetos:
- Cada PUT carrega ~200–400 bytes de cabeçalhos HTTP + URL + query string.
- Cada PUT enfrenta latência de roundtrip TLS (uns ~ms locais).
- Fastify roteador, validação de auth, parsing de query, hashing — overhead fixo por objeto.

Mesmo com 32 em paralelo (item #06), são ~26 000 "ondas" sequenciais.

## Mudança proposta

### Formato da requisição: framed binary stream

`POST /objects:bulk?batchId=<...>` com body `application/vnd.prosa.pack+binary`:

```
┌──────────────────────────────────────┐
│ MAGIC(4): "PRPK"                     │
│ VERSION(1): 0x01                     │
│ OBJECT_COUNT(varint)                 │
├──────────────────────────────────────┤
│ ENTRY 1:                             │
│   META_LEN(varint)                   │
│   META(JSON):                        │
│     { objectId, hash, transportHash, │
│       compression, compressedSize,   │
│       uncompressedSize, contentType }│
│   BYTES_LEN(varint)                  │
│   BYTES(raw)                         │
├──────────────────────────────────────┤
│ ENTRY 2: ... (N times)               │
├──────────────────────────────────────┤
│ TRAILER:                             │
│   BUNDLE_HASH(32 bytes blake3)       │
│   (over concat of object transport   │
│    hashes — lets server fast-fail    │
│    on transport corruption)          │
└──────────────────────────────────────┘
```

Caps (negociados via `handshake.limits`):
- `maxBulkObjects`: 64
- `maxBulkBytes`: 16 * 1024 * 1024 (16 MB)
- `maxObjectBytes` (já existe): 256 MB

Objetos maiores que `maxBulkBytes` continuam indo via PUT individual (path antigo preservado).

### Alternativas avaliadas

| Formato                           | Pros                          | Cons                                          |
| --------------------------------- | ----------------------------- | --------------------------------------------- |
| **Custom binary frame** (acima)   | Min overhead, streaming-fácil | Precisa de parser custom                      |
| **multipart/form-data**           | Browser-native, libs maduras  | Overhead de boundary, parsing chato em stream |
| **NDJSON com base64**             | Simples                       | +33 % bandwidth                               |
| **tar.zst sobre HTTP**            | Reuso de tooling              | Sequencial; menos controle de framing         |

Custom binary é o melhor trade-off para um internal protocol.

### Server: handler streaming

`apps/api/src/http/objects.ts` (atualmente o handler PUT em `objects.ts:395-429`) ganha sibling `POST /objects:bulk`:

```ts
app.post('/objects:bulk', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
  const batchId = req.query.batchId
  const parser = new PackParser(req.raw)            // stream-based
  const results: BulkPutResult[] = []
  const queue: Promise<void>[] = []
  const STORE_CONC = 16

  for await (const entry of parser.entries()) {
    // Backpressure: keep at most STORE_CONC stores in flight
    while (queue.length >= STORE_CONC) await Promise.race(queue)

    const task = (async () => {
      // validate transportHash on the fly, decompress if needed,
      // verify canonical hash, putIfAbsent in objectStore
      const result = await processSingleObject(entry, batchId)
      results.push(result)
    })()
    queue.push(task)
    task.finally(() => queue.splice(queue.indexOf(task), 1))
  }
  await Promise.all(queue)
  reply.send({ results })
})
```

### Client: pack builder

```ts
async function uploadObjectsBulk(client, batchId, objects: LocalCasObjectChunk[]) {
  const groups = packBySize(objects, MAX_BULK_BYTES, MAX_BULK_OBJECTS)
  await mapConcurrent(groups, 4 /* requests in flight */, async (group) => {
    const body = encodePack(group)
    await client.uploadObjectsBulk(batchId, body)
  })
}
```

## Impacto esperado

Cenário: 100 000 small CAS objects (~5 KB cada), em rede ~1 ms latency:

| Caminho            | RTTs    | Bytes em flight wave | Tempo total estimado |
| ------------------ | ------- | -------------------- | -------------------- |
| Hoje, conc=16      | 100 000 / 16 = 6 250  | ~80 KB    | ~25 s                |
| Após #06, conc=32  | 100 000 / 32 = 3 125  | ~160 KB   | ~12 s                |
| **Bulk, 64/req, conc=4** | 100 000 / 64 / 4 ≈ 391 | ~5 MB | **~1.5 s**           |

Ganho 1 ordem de magnitude na fase de bytes, **se houver bytes para subir**.

## Riscos e armadilhas

- **Overhead em re-syncs**: o caso do memo (a maioria dos batches com `missingObjects=0`) **não se beneficia** disso — o bulk endpoint só é chamado para objects realmente missing. Items #01 e #04 dominam para esse caso. Fazer #07 só após #01/#02 mostrar que a fase de bytes virou gargalo.
- **Memory pressure**: agrupar 64 objetos × até 16 MB pode demandar buffers consideráveis. Cap por bytes (não count) e usar streaming parser. Server-side: `Fastify bodyLimit` precisa ser configurado (já há precedente — o memo cita o aumento de bodyLimit no `planUpload`).
- **Atomicidade**: o bulk request **não é atômico** (`putIfAbsent` por objeto, sem transação global). Se a request quebrar no meio, alguns objetos foram subidos, outros não. Cliente faz retry do batch; `findMissingObjectIds` no próximo plan reportará só os que faltam ainda. Aceitável.
- **CAS dedup**: `putIfAbsent` no MinIO/local-fs já é idempotente. Sem race.
- **Auth**: cabeçalhos do PUT atual (Bearer token, tenant header) precisam ser preservados — facilmente, é só um POST.
- **Backwards compat**: manter `PUT /objects/:id` funcionando indefinidamente. CLI antiga continua interoperando.

## Como validar

1. **Bench sintético**: 100 000 objetos de 5 KB; medir wall-clock single-PUT vs bulk.
2. **Bench misto**: 10 000 objetos de 5 KB + 100 de 5 MB — confirmar fallback para PUT individual.
3. **Parser fuzz**: input malformado, truncated stream, wrong magic → erros claros, sem crash.
4. **Throughput sob carga**: 4 clients enviando bulk em paralelo — Fastify backpressure, MinIO conn pool.

## Dependências e ordem

- **Faça por último**. Só após #01, #02, #03, #04 estarem em produção e a fase de bytes ter sido medida como dominante.
- **Não acoplado** ao protocolo plan/commit — pode ir junto com bumps de versão de protocolo.
- Se o sistema crescer para uso WAN (não local), o ganho fica maior.

## Prior art

- **Git packfiles**: thin pack com server omitindo objetos conhecidos ([git-scm.com/docs/pack-protocol](https://git-scm.com/docs/pack-protocol)).
- **Sentry chunk endpoint**: 64 chunks/request, 32 MB cap, gzip/zstd encoding ([chunk.py](https://github.com/getsentry/sentry/blob/master/src/sentry/api/endpoints/chunk.py)).
- **restic** PR #3489 transitioned to async pack uploads ([github.com/restic/restic/pull/3489](https://github.com/restic/restic/pull/3489)).
- **casync**: chunks objetos em containers para reduzir per-object overhead ([github.com/systemd/casync](https://github.com/systemd/casync)).
- **JuiceFS** flushes blocks of 4 MiB; for many-small-files usa modo `--writeback` ([juicefs.com/docs/community/internals/io_processing](https://juicefs.com/docs/community/internals/io_processing/)).
