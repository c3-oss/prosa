# 07 — Endpoint `POST /objects:bulk` empacotado (pack file streaming)

> Status: Pending — tracked in [ROADMAP.md](../../ROADMAP.md#sync-performance). Siblings #01, #02, #04, #06, #08 e #09 já entregues (PRs #37–#47); ver git history.

**Tier**: 3 (maior impacto, maior esforço — só vale após #01/#02) · **Onde**: ambos · **Impacto estimado**: 5–10× na fase de bytes quando há muitos objetos pequenos · **Esforço**: M-L

## Fact-check 2026-05-16

**Veredicto**: parcialmente correta, mas deve ser tratada como protocolo novo,
não como patch médio. O gargalo de um PUT por objeto existe quando há muitos
`missingObjects`, mas o desenho atual chama de streaming algo que os handlers e
adapters existentes não suportam de ponta a ponta.

**Correções obrigatórias**:

- O Fastify atual só registra parser `application/octet-stream` com
  `parseAs: 'buffer'`. `application/vnd.prosa.pack+binary` precisa de
  parser/handler próprio e limite de corpo explícito.
- `RemoteObjectStore.putIfAbsent` aceita `AsyncIterable`, mas os adapters
  `memory`, `fs` e `s3` materializam bytes antes de gravar/verificar. A proposta
  deve assumir buffering bounded por objeto ou mudar a interface de storage.
- O bulk precisa repetir por entrada as garantias do `PUT`: usuário/tenant,
  batch aberto, objeto declarado, metadata idêntica ao manifest, `objectId`
  canônico BLAKE3 e `transportHash` separado.
- A rota HTTP atual não valida `deviceId`; ela valida tenant/user/batch. Se o
  bulk mudar isso, é hardening/protocolo novo.
- `maxBulkObjects`/`maxBulkBytes` exigem mudança no handshake/schema e fallback
  para clientes antigos.
- Rejeitar objectIds duplicados no pack e tratar race same-key em S3/FS/memory.

## Resumo

Hoje cada CAS object faltante vai num **PUT individual** para `/objects/:objectId`. Para um sync inicial de `~/.prosa`, isso pode chegar a centenas de milhares de PUTs. A literatura (Git packfiles, Sentry chunk API, restic pack files) converge em uma resposta: **empacotar N objetos pequenos numa única requisição** colapsa overhead TCP/TLS/HTTP/Fastify. Cap típico: ~64 objetos / ~16 MB por request, com server explodindo internamente em paralelo para o object store.

**Âncora empírica.** Sync completo de `~/.prosa` contra API + MinIO locais: 834 333 objetos CAS produziram ~167 ciclos plan/commit só na fase de CAS antes de qualquer linha de projeção ser promovida, e a maioria dos batches reportou `missingObjects=0` — cada um ainda paga um plan + commit round-trip fixo. Volume total observado: 3 141 sessions, 291 498 search_docs, 3 173 source_files, 811 511 raw_records, 1,1 M linhas de projeção, distribuídos em ~281 batches no modo chunked (`maxObjectsPerPlan=5000`, `maxRowsPerCommit=10 000`). É essa cardinalidade que motiva o desenho bulk-pack.

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

`POST /objects:bulk?batchId=<...>` com body `application/vnd.prosa.pack+binary`.
O formato precisa ser versionado e negociado no handshake; clientes antigos
continuam usando `PUT /objects/:objectId`.

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

### Server: handler streaming / buffering bounded

`apps/api/src/http/objects.ts` (atualmente o handler PUT em `objects.ts:395-429`)
ganha sibling `POST /objects:bulk`. Com os adapters atuais, o desenho realista é
“buffering bounded por entrada”, não streaming zero-copy end-to-end:

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
- **CAS dedup e isolamento tenant**: dedupe físico só pode ser usado depois que o tenant prova posse dos bytes. Não basta saber `blake3:<hash>` de outro tenant. O servidor deve exigir upload/pack declarado por um batch aberto do próprio tenant e registrar `remote_object_location` escopado por `(tenant_id, object_id)`.
- **S3 key count**: o path antigo cria um objeto S3 por CAS object (`objects/blake3/...`). O pack endpoint deve criar um objeto S3 por pack (`object-packs/<tenant>/<batch>/<packHash>.pack`) e mapear objetos individuais em SQL por range, evitando milhões de keys pequenas no bucket.
- **Pack verification**: `commitUpload`/`verifyPromotion` não podem validar apenas `offset + length <= packSize`. Devem checar `remote_blob.hash`/`byte_size` contra `objectStore.head(packKey)` e ler o range para comparar `transportHash` e hash canônico descomprimido.
- **DoS por descompressão agregada**: cada entry pode estar abaixo de `maxObjectBytes`, mas a soma dos `uncompressedSize` pode explodir. O endpoint precisa de cap agregado de bytes comprimidos/descomprimidos por pack e orçamento compartilhado durante decode.
- **PUT legado contra objeto packed**: se já existe location `pack`, o PUT individual não pode gravar bytes standalone órfãos. Ele deve ser tratado como idempotente quando for exatamente compatível ou rejeitado com cleanup do objeto recém-escrito.
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
