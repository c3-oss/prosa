# 09 — `Idempotency-Key` no `commitUpload` (retry-safe sem novo batch)

**Tier**: 3 · **Onde**: ambos · **Impacto estimado**: robustez (zera dobra de retrabalho em retries de rede) · **Esforço**: M

## Fact-check 2026-05-16

**Veredicto**: parcialmente correta. A lacuna é real: não há `Idempotency-Key` e
replay do mesmo `commitUpload` retorna 412 quando o batch já saiu de `open`.
Mas o desenho proposto não é crash-safe porque grava o cache depois do handler.
O registro idempotente precisa ser transacional com a mudança de status do
batch.

**Correções obrigatórias**:

- O erro atual é `PRECONDITION_FAILED`/HTTP 412, não `CONFLICT`.
- A tabela precisa de lease real: `status pending/completed`, `response_body`
  nullable enquanto pending, `locked_until`, `completed_at`, `expires_at`.
- A chave deve incluir `endpoint` (`tenant_id`, `endpoint`, `key`) e replay deve
  revalidar ou escopar por `user_id`, `batch_id`, `device_id` e `store_path`.
- `request_hash` deve cobrir input normalizado + endpoint + protocolVersion.
  `manifestHash` não substitui isso.
- O snippet diz UUID v7, mas `crypto.randomUUID()` gera UUID v4. Corrigir texto
  ou escolher biblioteca/implementação v7.

## Resumo

Hoje, se a resposta de `sync.commitUpload` se perder em trânsito (timeout, RST, 502), o cliente não tem como saber se o servidor processou o commit. O fluxo atual força `requireOpenBatchForCommit` (`apps/api/src/trpc/routers/sync/commit-upload.ts:78-85`) — batches em estado `committing` ou `committed` rejeitam novo commit, então o cliente precisa **criar outro batch e refazer plan + uploads + commit**. Caro. Solução padrão: header `Idempotency-Key` (Stripe-style) que faz o servidor cachear a resposta por 24 h e replicar em retries.

## Diagnóstico atual

`apps/api/src/trpc/routers/sync/batches.ts:?` (`requireOpenBatchForCommit`):

```ts
// pseudocode (não inspecionado, mas o callsite implica)
if (batch.status !== 'open') {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Batch is not open for commit' })
}
```

Cenário de falha:

1. Cliente envia `commitUpload` para `batch_X`.
2. Servidor processa: insere linhas, atualiza `status = 'committed'`, retorna `{ committedObjects, committedRows }`.
3. **Resposta perdida** (TCP RST, proxy timeout, conexão interrompida).
4. Cliente faz retry com mesmo body em `batch_X`.
5. Servidor: `status = 'committed'`, rejeita com `PRECONDITION_FAILED` / HTTP 412.
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

### Server-side cache / lease transacional

Nova tabela:

```sql
CREATE TABLE sync_idempotency_record (
  tenant_id   text       NOT NULL,
  key         uuid       NOT NULL,
  endpoint    text       NOT NULL,  -- 'sync.commitUpload' | 'sync.verifyPromotion'
  request_hash bytea     NOT NULL,  -- sha256 do body para detectar misuse
  response_body jsonb,
  status_code int        NOT NULL,
  status      text       NOT NULL DEFAULT 'pending',
  locked_until timestamptz,
  completed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, endpoint, key)
);
CREATE INDEX sync_idempotency_expires ON sync_idempotency_record (expires_at);
```

Middleware Fastify (ou tRPC procedure wrapper) só é suficiente se conseguir
gravar o resultado na mesma transação que muda o batch para `committed`. Caso
contrário, um crash depois do commit e antes do cache mantém o retry quebrado.
Uma forma mais segura é abrir/registrar o lease antes e completar o registro
dentro da transação de `commitUpload`.

```ts
async function withCommitIdempotency(opts: CommitOpts): Promise<CommitUploadOutput> {
  if (!opts.idempotencyKey) return commitUploadWithoutIdempotency(opts)

  const requestHash = sha256(stableJson({
    endpoint: 'sync.commitUpload',
    protocolVersion: opts.protocolVersion,
    input: opts.input,
  }))

  // 1. Outside the expensive handler, acquire or observe a pending/completed lease
  // scoped by tenant + endpoint + key. A completed lease can be replayed only
  // after lightweight auth/batch ownership checks pass.
  const lease = await acquireIdempotencyLease({
    tenantId: opts.tenantId,
    userId: opts.userId,
    endpoint: 'sync.commitUpload',
    key: opts.idempotencyKey,
    requestHash,
  })
  if (lease.status === 'completed') return lease.responseBody

  // 2. Complete the lease in the same DB transaction that transitions the batch
  // to committed. This is the critical crash-safety property.
  return opts.transaction(async (tx) => {
    const result = await commitUploadInTransaction(tx, opts)
    await completeIdempotencyLease(tx, {
      tenantId: opts.tenantId,
      endpoint: 'sync.commitUpload',
      key: opts.idempotencyKey,
      responseBody: result,
      statusCode: 200,
    })
    return result
  })
}
```

### Cleanup

Cron diário (ou pgBackground) que faz `DELETE FROM sync_idempotency_record WHERE expires_at < now()`.

### Race condition (two concurrent requests with same key)

Se duas requisições idênticas chegam simultaneamente, uma deve adquirir um lease
`pending` e as demais devem esperar `status='completed'` ou `locked_until`
expirar. O DDL precisa permitir `response_body IS NULL` enquanto pending.

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
2. **Misuse**: chamar com mesma key mas body diferente → erro explícito de reuso indevido da key.
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
