# 04 — Paralelizar `requireStoredObject` no `commitUpload` + fast-path quando `missingObjects=0`

**Tier**: 2 · **Onde**: servidor · **Impacto estimado**: 16–32× nesta fase específica · **Esforço**: XS (~10 LoC)

## Fact-check 2026-05-16

**Veredicto**: parcialmente válida. Paralelizar `requireStoredObject` com limite
é seguro e ataca um gargalo real. Pular o `head()` quando `missingObjects=0`
altera a garantia documentada de `commitUpload` e deve ser tratado como mudança
de protocolo/semântica, idealmente atrás de feature flag.

**Correções obrigatórias**:

- `plan_missing_count` não existe hoje em `sync_batch`.
- `verifyPromotion` valida todos os objetos do manifesto do batch, não
  `sampleSessionIds + declaredObjectIds`. `sampleSessionIds` só controla amostra
  de sessões retornada.
- `verifyPromotion` também tem loop serial de `tenant_object SELECT` +
  `objectStore.head()` por objeto; se esta proposta remover custo do commit,
  esse custo reaparece na verificação.
- A doc de arquitetura diz que `commitUpload` confirma todos os CAS bytes. O
  fast path muda isso para “trust plan, prove in verify”.

## Resumo

Antes da transação, o `commitUpload` re-verifica via `head()` **todos os objetos** declarados — inclusive os que o `planUpload` já confirmou existir. Esse loop é serial. Solução em duas camadas: (a) paralelizar o loop com concorrência limitada (sem mudança semântica); (b) opcionalmente, pular o loop quando `plan_missing_count = 0` e o batch é "fresco", desde que essa confiança no plano seja registrada no protocolo/docs e que `verifyPromotion` continue sendo gate de reads/cleanup.

## Diagnóstico atual

`apps/api/src/trpc/routers/sync/commit-upload.ts:69-73`

```ts
let committedObjects = 0
for (const obj of objects) {                                        // ← serial
  const storageKey = storageKeyForObject(obj)
  await requireStoredObject({ objectStore: ctx.objectStore, object: obj, storageKey })
}
```

`requireStoredObject` (`manifest.ts:196-214`) é um `head()` simples no object store. Para um batch CAS-only com 5 000 objetos previamente confirmados pelo `planUpload`, isso são **5 000 round-trips MinIO seriais** antes de a transação começar. Mesmo padrão se repete em **167 batches**.

Adicionalmente, dentro da transação (`commit-upload.ts:97-109`), há um segundo loop serial chamando `assertRemoteObjectCatalog` por objeto — coberto pelo item #02.

## Mudança proposta

### (a) Paralelização sem mudança semântica

```ts
const HEAD_CONCURRENCY = 32

await pMapBounded(objects, HEAD_CONCURRENCY, async (obj) => {
  const storageKey = storageKeyForObject(obj)
  await requireStoredObject({ objectStore: ctx.objectStore, object: obj, storageKey })
})
```

Mantém o invariante: se algum objeto sumiu entre plan e commit, ainda falha. Apenas verifica em paralelo.

### (b) Fast-path opcional para `missingObjects=0`

Acrescenta uma coluna `plan_missing_count int` em `sync_batch` (preenchida no `planUpload`). No `commitUpload`:

```ts
const batchRow = await tx<{ plan_missing_count: number; created_at: Date }>(
  'SELECT plan_missing_count, created_at FROM "sync_batch" WHERE id = $1 AND tenant_id = $2',
  [input.batchId, ctx.tenantId],
)
const ageMs = Date.now() - new Date(batchRow[0]!.created_at).getTime()
const TRUST_WINDOW_MS = 5 * 60_000

if (batchRow[0]!.plan_missing_count === 0 && ageMs < TRUST_WINDOW_MS) {
  // Skip head() loop — assume os objetos seguem presentes.
  // verifyPromotion (passo posterior) ainda valida a integridade global.
} else {
  await pMapBounded(objects, HEAD_CONCURRENCY, async (obj) => {
    await requireStoredObject({ ... })
  })
}
```

A janela de 5 min é uma heurística: tempo entre `planUpload` e `commitUpload` numa rede saudável é segundos.

## Impacto esperado

Cenário típico do memo: batch CAS-only com `missingObjects=0`, 5 000 objetos:

| Versão                | Tempo loop `head()`         |
| --------------------- | --------------------------- |
| Serial (atual)        | ~5 s (latência local 1 ms)  |
| Paralelo conc. 32     | ~0,16 s                     |
| Fast-path (skip)      | ~0 ms                       |

Para 167 batches CAS-only sem missing objects: **fast-path economiza ~13 minutos**; só a paralelização economiza ~12,5 minutos.

## Riscos e armadilhas

- **(a) é seguro**: o predicado de cada `head()` é independente. Paralelizar não afeta consistência.
- **(b) janela de confiança**: se um operador apagar manualmente o bucket entre `planUpload` e `commitUpload`, o fast-path comita sem detectar. Mitigação:
  - `verifyPromotion` posterior reabre o manifesto do batch e revalida todos os
    objetos declarados; `sampleSessionIds` não participa da prova de objetos.
  - A janela de 5 min torna o cenário muito específico.
  - O fast-path é **opcional** — pode ficar atrás de um feature flag (`PROSA_TRUST_PLAN_RESULT=1`) e ligar só após observação.
- **Por que (a) sozinho não é suficiente**: 5 s × 167 batches ainda é ~14 min. Vale fazer ambos.
- **Não confundir com `assertRemoteObjectCatalog` dentro da transação**: esse loop é coberto por #02 (bulk SELECT do `remote_object`).

## Como validar

1. **(a) Sem regressão**: testes de `apps/api/test/sync.test.ts` para commit-happy-path e commit-with-missing-object devem passar.
2. **Bench**: medir tempo de `commitUpload` antes/depois para batch com 5 000 objetos já presentes.
3. **(b) Negativo**: simular objeto removido do MinIO entre plan e commit → verificar que `verifyPromotion` ainda falha (defesa em profundidade).
4. **Telemetria**: logar `commitUpload.headLoopMs` antes/depois — deve cair de segundos para dezenas de ms.

## Dependências e ordem

- **Independente de #01, #02, #03**. Pode ir em uma PR cosmética separada.
- **Sinergético com #03**: paralelismo cliente-side amplifica o custo do head loop em flight.

## Prior art

- Padrão "trust the plan, verify globally": exatamente o que Git faz com `--allow-shallow` + `git fsck` posterior.
- AWS S3 SDK PUT default é HEAD-skippable quando o caller declara conhecer o estado ([guideline de Anti-patterns 2024](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance-guidelines.html)).
