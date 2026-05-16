# 09 — `Idempotency-Key` no `commitUpload` (retry-safe sem novo batch)

**Tier**: 3 · **Onde**: ambos · **Impacto estimado**: robustez (zera dobra de retrabalho em retries de rede) · **Esforço**: M

## Resumo

Hoje, se a resposta de `sync.commitUpload` se perder em trânsito (timeout, RST, 502), o cliente não tem como saber se o servidor processou o commit. O fluxo atual força `requireOpenBatchForCommit` (`apps/api/src/trpc/routers/sync/commit-upload.ts:78-85`) — batches em estado `committing` ou `committed` rejeitam novo commit, então o cliente precisa **criar outro batch e refazer plan + uploads + commit**. Caro. Solução padrão: header `Idempotency-Key` (Stripe-style) que faz o servidor cachear a resposta por 24 h e replicar em retries.

## Diagnóstico atual

`apps/api/src/trpc/routers/sync/batches.ts:?` (`requireOpenBatchForCommit`):

```ts
// pseudocode (não inspecionado, mas o callsite implica)
if (batch.status !== 'open') {
  throw new TRPCError({ code: 'CONFLICT', message: 'batch already committed/failed' })
}
```

Cenário de falha:

1. Cliente envia `commitUpload` para `batch_X`.
2. Servidor processa: insere linhas, atualiza `status = 'committed'`, retorna `{ committedObjects, committedRows }`.
3. **Resposta perdida** (TCP RST, proxy timeout, conexão interrompida).
4. Cliente faz retry com mesmo body em `batch_X`.
5. Servidor: `status = 'committed'`, rejeita com `CONFLICT`.
6. Cliente: cria `batch_Y`, refaz plan + uploads + commit. **Trabalho duplicado**: até 10k linhas + N MB de bytes inúteis.

A semântica do `planUpload` mitiga parcialmente (objetos já existem → `missingObjects=[]`), mas **a fase de commit em si é re-executada**, e #01/#02 ainda gastam queries.

## Mudança proposta

### Header `Idempotency-Key`

Cliente gera um UUID v7 (lexicográfico, ordem temporal) por **tentativa de commit**, persiste no checkpoint local (item #08), e reusa em retries do mesmo batch:

```ts
const idempotencyKey = checkpoint.pendingCommit?.idempotencyKey ?? crypto.randomUUID()
const commit = await client.syncCommitUpload({
  batchId: plan.batchId,
  deviceId,
  storePath,
  objects: objectEntries,
  projection,
}, { idempotencyKey })
```

### Server-side cache

Nova tabela:

```sql
CREATE TABLE sync_idempotency_record (
  tenant_id   text       NOT NULL,
  key         uuid       NOT NULL,
  endpoint    text       NOT NULL,  -- 'sync.commitUpload' | 'sync.verifyPromotion'
  request_hash bytea     NOT NULL,  -- sha256 do body para detectar misuse
  response_body jsonb    NOT NULL,
  status_code int        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, key)
);
CREATE INDEX sync_idempotency_expires ON sync_idempotency_record (expires_at);
```

Middleware Fastify (ou tRPC procedure wrapper):

```ts
async function withIdempotency<T>(opts: {
  rawExec: RawExec
  tenantId: string
  key: string | undefined
  endpoint: string
  requestBody: unknown
  handler: () => Promise<T>
}): Promise<T> {
  if (!opts.key) return opts.handler()  // optional
  const requestHash = sha256(stableJson(opts.requestBody))

  const existing = await opts.rawExec(
    'SELECT request_hash, response_body, status_code FROM "sync_idempotency_record" WHERE tenant_id = $1 AND key = $2 AND expires_at > now() LIMIT 1',
    [opts.tenantId, opts.key],
  )
  if (existing[0]) {
    if (!buffersEqual(existing[0].request_hash, requestHash)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Idempotency-Key reused with different payload' })
    }
    return JSON.parse(existing[0].response_body) as T  // replay
  }

  const result = await opts.handler()
  await opts.rawExec(
    'INSERT INTO "sync_idempotency_record"(tenant_id, key, endpoint, request_hash, response_body, status_code) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
    [opts.tenantId, opts.key, opts.endpoint, requestHash, JSON.stringify(result), 200],
  )
  return result
}
```

### Cleanup

Cron diário (ou pgBackground) que faz `DELETE FROM sync_idempotency_record WHERE expires_at < now()`.

### Race condition (two concurrent requests with same key)

Se duas requisições idênticas chegam simultaneamente, a primeira que conseguir `INSERT … ON CONFLICT DO NOTHING` ganha; a segunda lê a resposta em cache. Para evitar ambas executarem `opts.handler()` em paralelo, usar `INSERT ... ON CONFLICT (tenant_id, key) DO NOTHING RETURNING xmin` e, se a inserção falhou, esperar (poll com backoff) até `response_body IS NOT NULL`. Padrão `lease`.

## Impacto esperado

Caso de sucesso (sem retry): **+1 INSERT por commit** (8 a 16 + 1 = +6 % queries — irrelevante).

Caso de retry após crash (network-side): **N×** menos trabalho — replay direto da resposta cacheada em vez de re-executar `commitUpload` inteiro.

Combinado com #08 (checkpoint preserva idempotencyKey): retries cross-process também aproveitam o cache.

## Riscos e armadilhas

- **Tamanho do cache**: 24 h × N batches por dia × ~1 KB/resposta. Para 1000 syncs/dia de 300 batches: ~300 MB. Toleráveis. Cleanup diário mantém estável.
- **Reuso indevido de key**: cliente bugado reusa key entre batches diferentes — o `request_hash` mismatch detecta e falha claramente.
- **PK cross-tenant**: a `(tenant_id, key)` previne colisão entre tenants. Mas se cliente usar a mesma UUID v7 globalmente, podem haver matches em tenants diferentes — sem problema, porque a unique pelo tuple.
- **Resposta crescente**: se o response body for grande (e.g. um `verifyPromotion` com sample IDs), armazenar `jsonb` é caro. Limitar tamanho cacheado a, e.g., 64 KB; acima disso, não cachear.
- **Não-determinismo de timestamps**: response cacheada inclui timestamps gerados no commit original. Replay devolve os mesmos — semanticamente correto.

## Como validar

1. **Happy path**: chamar `commitUpload` com `Idempotency-Key: K`, depois com a mesma key — segunda chamada retorna mesma resposta sem reexecutar (validar via log de queries).
2. **Misuse**: chamar com mesma key mas body diferente → CONFLICT explicit.
3. **TTL**: forjar `expires_at` no passado, validar reentrada da execução real.
4. **Concorrência**: spawn 5 requests com mesma key simultaneamente → exatamente 1 chega ao handler real.
5. **Falha do handler**: se `handler()` lança, **não** cachear a resposta (estado consistente).

## Dependências e ordem

- **Sinergético com #08** (checkpoint local guarda a key entre execuções).
- **Independente** das otimizações de performance (#01–#06). Pode ir em qualquer ordem.
- **Estende para `verifyPromotion`**: mesma técnica protege essa chamada também.

## Prior art

- **Stripe API**: `Idempotency-Key` header, 24h cache, body-hash validation ([stripe.com/docs/api/idempotent_requests](https://stripe.com/docs/api/idempotent_requests)).
- **AWS API Gateway**: idempotency tokens em endpoints SDK.
- **Square, PayPal, ACH**: padrão idêntico.
- **IETF draft**: [draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/) — em padronização.
