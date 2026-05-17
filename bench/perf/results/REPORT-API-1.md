# REPORT — API-1 `sync.commit-upload` + `objects` (servidor)

> Servidor `apps/api/dist/bin/prosa-api.js` rodando local com `--cpu-prof --heap-prof --trace-gc`. Postgres 16-alpine (`shared_preload_libraries=pg_stat_statements`) em Docker `:55432`, MinIO em `:19000`. Workload: cold sync (timeout 120 s) de bundle smoke (3500 sessões, 912k CAS objects). macOS arm64 (Apple M1 Pro, 16 GB), Node 24.12.0, commit `5959a9d`. Run: `bench/perf/results/20260516T055033Z-api-1/`.

> **Wall-time cliente**: 120 065 ms (timeout, sync NÃO completou — bundle muito grande para 120 s, mas suficiente para profile). Objects PUT processados: **10 000**. tRPC procedures invocadas: **8**.

## Métricas brutas

`pg_stat_statements` overview (após 120 s):

| Métrica | Valor |
|---|---|
| Distinct queries | 117 |
| Total calls | 249 433 |
| Total exec time (Postgres) | 13 782 ms |

CPU profile (`server.cpuprofile` — 4.8 MB, sampling 500 µs):

| Frame self-time | % | ms | Categoria |
|---|---:|---:|---|
| `(idle)` | **51.1%** | 62 911 | I/O wait (rede para MinIO / Postgres) |
| `@noble/hashes blake2.js:309 compress` | 2.2% | 2 670 | hash check (BLAKE2 JS puro) |
| `writeBuffer` | 2.0% | 2 454 | buffer flush (socket) |
| garbage collector | 1.8% | 2 231 | GC |
| `runMicrotasks` | 1.7% | 2 098 | promise tick |
| `postgres/result.js` | 0.8% | 1 026 | postgres-js result parsing |
| `@smithy/schema (AWS SDK)` | 0.8% | 1 020 | AWS SDK serialization |
| `@noble/hashes _blake.js G2s` | 0.8% | 1 006 | BLAKE2 rounds |
| `@noble/hashes _blake.js G1s` | 0.8% | 991 | BLAKE2 rounds |
| `@smithy/endpoints` | 0.7% | 834 | S3 endpoint resolve |
| `@smithy/retry` | 0.7% | 828 | retry middleware |
| `@aws-sdk httpAuthSchemes` | 0.6% | 796 | S3 SigV4 signing |
| `zstd-napi decompress` | 0.5% | 575 | zstd unpack |

Heap profile (`server.heapprofile`):

| Alloc site | % | MB |
|---|---:|---:|
| `parseJSONFromBytes` (undici) | 12.6% | 8.43 |
| `compileSourceTextModule` | 7.8% | 5.25 |
| `decode` (utf-8) | 5.9% | 3.98 |
| `extractBody` (undici) | 5.5% | 3.69 |
| `readFileSync` | 4.8% | 3.20 |
| `sourceMapFromFile` | 4.7% | 3.16 |
| `set hash` (URL) | 3.1% | 2.10 |
| `zod@4.4.3 schemas` | 2.4% | 1.58 |
| `mergeObjectSync zod@3.25.76` | 2.3% | 1.57 |

## Sumário executivo

| # | Área | Sintoma | Causa raiz hipotetizada | Impacto | Esforço | Confiança |
|---|------|---------|--------------------------|---------|---------|-----------|
| A1 | **Comm-upload N+1** confirmado em PG | 3 500 `SELECT projection_session` (4.02 % do exec time) por ÚNICO commit-upload. + 6500 `SELECT projection_message`, 10 000 `INSERT sync_batch_projection_manifest`. | `insertProjectionRows` em `apps/api/src/trpc/routers/sync/projection-upserts.ts:584-661` faz 9 loops sequenciais com `SELECT + INSERT` por linha. **Confirmado em `pg_stat_statements`**. | redução de **3 500 PG roundtrips** para 1-2 bulk upserts. Em conexão Docker (~0.04 ms/call), economiza ~140 ms; em conexão real (1 ms RTT), economiza ~3.5 s por commit. Multiplica-se por batch_concurrency. | **M** | **alta** (2 métodos: estático + pg_stat) |
| A2 | **`tenant_object` lookup repetido 3.75×/objeto** | 37 586 calls de `SELECT object_id FROM tenant_object WHERE tenant_id = $1 AND object_id = $2 LIMIT $3` (7.09 % exec time). Apenas 10 000 objetos foram processados. | Cada PUT /objects emite múltiplas verificações (provavelmente em `requireStoredObject` ou `verifyCommitObjectBytes`). | redução de **27 000 PG roundtrips** se cachear em-memory ou consolidar lookups em uma chamada. | S | **alta** |
| A3 | **`sync_batch_object_manifest` JOIN custa 25 % do PG** | 10 000 calls (1 por PUT) consumindo 25.05 % do total_exec_time da janela. 977 332 buffer hits — query lê páginas do batch manifest a cada PUT. | `SELECT m.canonical_hash...FROM sync_batch_object_manifest m JOIN sync_batch b ON b.id = m.batch_id` é executado por object PUT para validar batch ownership. | mover ownership check para cache (em-memory) por batch — uma vez por planUpload, válido até commit. | M | alta |
| A4 | **BLAKE2 JS puro na verificação de hash de objetos** | 3.8 % combinado em `@noble/hashes blake2.js compress + G1s + G2s`. | Server recomputa hash do bytes recebidos em `objects.ts` ou `commit-upload.ts` para verificar `transportHash`. Usa `@noble/hashes` em JS. | substituir por `crypto.createHash('blake2b512')` nativo (Node + OpenSSL) ou xxhash-addon → ganho ~3-5×. Custo escala com volume de bytes recebidos. | S | alta |
| A5 | **AWS SDK overhead per PUT** | 3 % combinado em `@smithy/*` (schema, endpoints, retry, signing). | S3 client v3 tem middleware stack pesado, executado por PutObject. | habilitar `requestHandler.connectionTimeout` baixo, keep-alive, e considerar `S3Client` único compartilhado entre requests (validar que já é). | XS-S | média (avaliação) |
| A6 | **51 % idle = sync é I/O bound** | Server espera 62.9 s de 123 s amostrados. | Rede para MinIO (loopback) + fsync de Postgres. CPU não é o gargalo. | aumentar `object-concurrency` no cliente até CPU server >70 %; ou batchear PUTs S3. | varies | alta |
| A7 | **Zod v3 E v4 ambos carregados** | 4.7 % do heap em zod v3 + v4. | `zod@3.25.76` no `apps/api/package.json` + `zod@4.4.3` arrastado por transitive (Better Auth ou tRPC?). Sub-ótimo. | unificar em zod v4 (ou v3). | S (lockfile) | alta |
| A8 | **`resolveMembership` por procedure** | 10 007 `SELECT role FROM "member"` (1.62 %). Apenas 8 tRPC calls mas auth roda em rotas /objects também. | Better Auth + tenant guard chamam para CADA HTTP request (incluindo PUT /objects). | habilitar `session.cookieCache` em Better Auth — economiza 10 000 roundtrips por sync. | **XS** | alta |

## Cenário

```bash
# (em paralelo) Server profilado:
node --enable-source-maps --trace-gc \
  --cpu-prof --cpu-prof-dir=$RUN_DIR/profiles --cpu-prof-interval=500 \
  --heap-prof --heap-prof-dir=$RUN_DIR/profiles \
  apps/api/dist/bin/prosa-api.js

# Cliente:
timeout 120 node --enable-source-maps apps/cli/dist/bin/prosa.js sync \
  --server http://127.0.0.1:30082 --store /tmp/prosa-perf-bundle-...-smoke \
  --keep-local --object-concurrency 16 --batch-concurrency 4 --json
```

**Patch necessário em `apps/api/dist/bin/prosa-api.js`** (só para profile flushar em SIGTERM, não é otimização):
```js
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => process.exit(0));
}
```

## Hot paths (detalhe)

### A1 — `commit-upload` faz SELECT+INSERT por row

**Confirmação dinâmica via `pg_stat_statements`**:

```
calls  total_ms  mean_ms  pct    query_head
3500   554       0.16     4.02   SELECT source_kind, project_id... FROM "projection_session" WHERE tenant_id=$1 AND id=$2 LIMIT $3
6500   200       0.03     1.45   INSERT INTO "projection_message"(...) VALUES (...)
6500   79        0.01     0.57   SELECT session_id, turn_id... FROM "projection_message" WHERE tenant_id=$1 AND id=$2 LIMIT $3
3500   129       0.04     0.94   INSERT INTO "projection_session"(...) VALUES (...)
10000  523       0.05     3.79   INSERT INTO "sync_batch_projection_manifest"(batch_id, tenant_id, entity_type, entity_id) VALUES (...)
```

3 500 sessions = 3 500 SELECT + 3 500 INSERT projection_session + 3 500 INSERT projection_manifest = **10 500 PG roundtrips** apenas para uma única sequência de commit.

6 500 messages = mais 13 000 roundtrips (SELECT + INSERT + manifest). Pattern repete-se para outras 7 entity types não top-30.

**Estimativa total**: para um sync completo de 3 500 sessões (~70 000 projection rows totais), o servidor faria ~210 000 PG roundtrips só em `commit-upload`. Trocando por bulk upserts (`INSERT ... SELECT FROM unnest($1, $2, ...) ON CONFLICT DO UPDATE`), são **~9 statements** (um por entity type). Redução de **~23 000×** em statement count, e o exec time despenca proporcionalmente porque postgres-js paga prepare/transport overhead por statement.

**Notas de implementação**:

- `apps/api/src/trpc/routers/sync/projection-upserts.ts:584-661` é o ponto único de mudança.
- `apps/api/src/trpc/routers/sync/projection-upserts.ts:54-76` (`insertOrVerifyRow`) seria substituído por `ON CONFLICT DO UPDATE` com `RETURNING xmax = 0 AS inserted` para detectar conflito.
- Manter ordem entre entity-types por FKs (sessions antes de messages etc.) ou usar `DEFERRABLE INITIALLY DEFERRED` se aceitável.

### A2 — `tenant_object` lookup repetido 3.75×/objeto

```
calls   total_ms  mean_ms  pct    query
37586   977       0.03     7.09   SELECT object_id FROM "tenant_object" WHERE tenant_id = $1 AND object_id = $2 LIMIT $3
```

10 000 objetos PUT → 37 586 calls = **3.75 SELECTs por objeto**. Isto sugere que `requireStoredObject` ou `verifyCommitObjectBytes` faz múltiplas validações no mesmo objeto.

**Investigar**: `apps/api/src/trpc/routers/sync/commit-upload.ts:118-179` e `apps/api/src/objects/...`. Padrão suspeito: pode estar verificando o objeto em diferentes pontos do pipeline (PUT → batch index → commit).

**Proposta**: consolidar em um único `SELECT object_id FROM tenant_object WHERE object_id = ANY($1::text[])` no início do commit, e reutilizar resultado.

### A3 — `sync_batch_object_manifest` JOIN dominante

10 000 calls (25 % do exec time, 0.35 ms média) consumindo 977 332 buffer hits.

Esta query roda **por PUT /objects**:

```sql
SELECT m.canonical_hash, m.transport_hash, m.compression, m.uncompressed_size, m.compressed_size
FROM "sync_batch_object_manifest" m
JOIN "sync_batch" b ON b.id = m.batch_id AND b.tenant_id = m.tenant_id
WHERE ...
```

**Proposta**: o resultado do manifest é determinístico per (batch_id, object_id). Cachear em memória por batch durante a vida do batch (TTL = duração do upload, ~minutos). Redução: 10 000 → ~1-10 queries (1 fetch inicial, depois cache hits).

**Risco**: cache invalidation; mas batch é write-once durante upload, então invalidação é trivial (delete cache quando batch.status muda).

### A4 — BLAKE2 JS puro no servidor

```
2.2%  2670ms  @noble/hashes/blake2.js:309 compress
0.8%  1006ms  @noble/hashes/_blake.js:38 G2s
0.8%  991ms   @noble/hashes/_blake.js:31 G1s
= 3.8% combined (~4667 ms in 120s of profile)
```

Servidor faz BLAKE2 sobre bytes recebidos para verificar `transportHash` em PUT /objects. Como objects são pequenos (avg <2 KB pelo log), há ~10 000 hashings em 120 s.

**Proposta**: substituir `@noble/hashes` por `crypto.createHash('blake2b512')` nativo do Node (usa OpenSSL, ~5-10× mais rápido para blocos pequenos). Ganho esperado: 3 % → <1 % do CPU server. Maior diferença ainda no client (CLI-1 REPORT).

**Cuidado contratual**: o manifesto declara `hash_alg=blake3`, mas profile mostra `blake2.js`. Há duas opções:
- BLAKE2 sendo usado para `transportHash` (transporte temporário), enquanto BLAKE3 é o canonical hash do CAS. Razoável design.
- Confusão / código legado.

Auditar `packages/prosa-storage/src/...` para entender qual hash é usado onde.

### A5 — AWS SDK Smithy overhead

Combinando `@smithy/schema`, `@smithy/endpoints`, `@smithy/retry`, `@smithy/protocols`, `@aws-sdk/core/httpAuthSchemes`:

```
0.8% + 0.7% + 0.7% + 0.5% + 0.6% = 3.3% (~4060 ms)
```

Por PutObject. Em 10 000 PUTs (escalando para 912k objetos no sync completo) isso vira ~370 s só de SDK overhead.

**Proposta**: garantir `S3Client` é singleton (não criado per request). Habilitar HTTP/2 keep-alive. Considerar trocar middleware customizado por wrapper minimal se AWS SDK não for crítico.

Achado de menor impacto comparado a A1-A4, mas vale anotar.

### A6 — Server é I/O-bound (51 % idle)

Não é um bug, é o estado natural: o gargalo está em rede (MinIO sobre loopback) e Postgres fsync. O cliente pode aumentar concurrency sem saturar CPU server.

**Proposta cliente-side**: subir `--object-concurrency` de 16 para 32-64. **Risco**: client RAM (cada concurrent upload mantém buffer ~tamanho médio do objeto na memória).

Conexão real (servidor remoto) com latência >10 ms terá idle ainda mais alto — a otimização do A1-A4 acelera mais.

### A7 — zod v3 + v4 ambos no heap

```
2.4% (1.58 MB) zod@4.4.3 schemas
2.3% (1.57 MB) zod@3.25.76 helpers/parseUtil
```

`apps/api/package.json` declara `zod ^3.23.8`. v4.4.3 vem por trans dep (Better Auth ou outro). Verificar:

```bash
pnpm why zod  # listar todos os imports de zod
```

**Proposta**: pin uma versão única via `pnpm.overrides`. Reduz bundle size e heap startup.

### A8 — `resolveMembership` chamado em todas as rotas

```
10007 calls SELECT role FROM "member" WHERE organization_id = $1 AND user_id = $2
10009 calls SELECT FROM session WHERE token = $1
10009 calls SELECT FROM user WHERE id = $1
```

Em 120 s, ~10 000 auth-related queries. Cada PUT /objects passa por auth, mesmo se a sessão já foi validada milhares de vezes nas últimas centenas de ms.

**Proposta**: habilitar `cookieCache: { enabled: true, maxAge: 300 }` em Better Auth (`apps/api/src/auth.ts`). Diminui auth-related queries de 10 000+ para ~poucos por sync.

**Validação**: re-rodar com cache habilitado, confirmar que `member`/`session`/`user` cai para <100 calls (apenas no início do sync).

## Falsos positivos descartados

- **`parseJSONFromBytes` 12.6 % heap (undici)**: HTTP body parsing, é estrutural — pode ser reduzido por `fastify` body parser config mas raramente vale.
- **`compileSourceTextModule` 7.8 % heap**: startup; não escala com workload.

## Falsos positivos a vigiar (predições antes do run que não se confirmaram)

- **Predição inicial: `zstd-napi decompress` dominante**. Realidade: 0.5 % apenas, porque os payloads aqui são pequenos (zstd embora rápido, pouco trabalho).
- **Predição: Better Auth `getSession` 1-5 ms × N**. Realidade: confirmado em pg_stat_statements (A8), e os mean times batem (~0.02 ms cada). O custo está nos N _calls_, não no _per-call_ — concentrar em cookieCache.
