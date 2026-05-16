# 02 — Bulk-ify per-row loops em `commitUpload` (UNNEST + `ON CONFLICT`)

**Tier**: 1 · **Onde**: servidor · **Impacto estimado**: 50–500× redução em queries por commit · **Esforço**: M (refactor focado em 2 arquivos)

## Fact-check 2026-05-16

**Veredicto**: parcialmente correta, mas não implementar como escrita. O
gargalo row-by-row existe em `commitUpload` e `projection-upserts`, mas a
proposta está desatualizada e o skeleton SQL de conflito é inseguro sob corrida.

**Correções obrigatórias**:

- O protocolo atual tem **6 tipos de projeção**, não 4: `sourceFiles`,
  `rawRecords`, `sessions`, `searchDocs`, `toolCalls`, `toolResults`.
- `sync_batch_object_manifest` é escrito em `planUpload`, não em `commitUpload`.
- O fluxo normal de PUT já insere `remote_object`; no commit, o pior caso por
  objeto pode chegar a `assertRemoteObjectCatalog` + `SELECT` + `INSERT` +
  `tenant_object`.
- A CTE `conflicts` antes de `INSERT ... ON CONFLICT DO NOTHING` pode aceitar
  silenciosamente uma linha divergente inserida concorrentemente entre a checagem
  e o insert. A implementação precisa fazer verificação pós-insert em bulk ou
  usar `ON CONFLICT DO UPDATE ... WHERE campos equivalentes RETURNING` e validar
  que todos os IDs foram cobertos.
- A normalização de `raw_record.payload` removendo `importBatchId` deve continuar
  no servidor. Não mover essa equivalência apenas para o cliente.

## Resumo

`commitUpload` hoje executa **dezenas de milhares de queries seriais por batch** dentro de uma única transação, todas seguindo o padrão `SELECT → maybe INSERT`. Substituir os loops por operações bulk é a direção correta, mas o desenho precisa preservar a semântica atual de conflito/idempotência. O padrão “pré-checar conflitos e depois `ON CONFLICT DO NOTHING`” não é suficiente sob concorrência; prefira verificação pós-insert ou `ON CONFLICT DO UPDATE ... WHERE equal RETURNING`.

## Diagnóstico atual

Loops seriais por commit:

### 1. Re-validação do catálogo de objetos
`apps/api/src/trpc/routers/sync/commit-upload.ts:97-109` chama, por objeto:
- `assertRemoteObjectCatalog` → 1 SELECT (`manifest.ts:165-194`)
- `insertRemoteObjectIfMissing` → 1 SELECT + (talvez) 1 INSERT (`commit-upload.ts:17-40`)
- `attachTenantObject` → 1 INSERT `ON CONFLICT DO NOTHING` (`commit-upload.ts:42-54`)

→ até **3N queries** para N objetos.

### 2. Linhas de projeção
`apps/api/src/trpc/routers/sync/projection-upserts.ts:251-292`:

```ts
for (const session of projection.sessions) {
  await insertProjectionManifest({ ... })  // 1 INSERT
  await insertSessionRow({ ... })          // 1 SELECT + maybe 1 INSERT
}
// idem para sourceFiles, rawRecords, searchDocs, toolCalls, toolResults
```

→ até **3M queries** para M linhas de projeção totais.

### Custo combinado (limites máximos)

| Etapa                | Queries (worst-case)        |
| -------------------- | --------------------------- |
| Objetos (N=5000)     | até 15 000                  |
| Projeção (M=10 000)  | até 30 000                  |
| **Total por commit** | **até 45 000 queries seriais** |
| × 281 batches        | **~12,6 milhões de queries** |

Tudo dentro de transações Postgres separadas, com WAL flush por commit.

## Mudança proposta

Padrão aplicável a `remote_object`, `tenant_object`, `projection_session`,
`source_file`, `raw_record`, `search_doc`, `projection_tool_call`,
`projection_tool_result` e `sync_batch_projection_manifest`. O
`sync_batch_object_manifest` pertence ao `planUpload` e deve ser tratado em uma
proposta/patch separado.

### Skeleton

```sql
-- 1) Bulk-load valores recebidos em uma CTE via unnest:
WITH incoming AS (
  SELECT *
  FROM unnest(
    $1::text[],        -- ids
    $2::text[],        -- source_kind
    $3::text[],        -- project_id
    $4::text[],        -- title
    $5::timestamptz[], -- started_at
    $6::timestamptz[], -- ended_at
    $7::int[],         -- turn_count
    $8::jsonb[]        -- metadata
  ) AS t(id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
),
-- 2) Identificar conflitos antes do INSERT (linhas existentes com valores diferentes):
conflicts AS (
  SELECT i.id
  FROM incoming i
  JOIN projection_session e ON e.tenant_id = $tenant AND e.id = i.id
  WHERE e.source_kind  IS DISTINCT FROM i.source_kind
     OR e.project_id   IS DISTINCT FROM i.project_id
     OR e.title        IS DISTINCT FROM i.title
     OR e.started_at   IS DISTINCT FROM i.started_at
     OR e.ended_at     IS DISTINCT FROM i.ended_at
     OR e.turn_count   IS DISTINCT FROM i.turn_count
     OR e.metadata     IS DISTINCT FROM i.metadata
),
-- 3) Inserir apenas o que não conflita:
inserted AS (
  INSERT INTO projection_session
    (tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
  SELECT $tenant, i.id, i.source_kind, i.project_id, i.title,
         i.started_at, i.ended_at, i.turn_count, i.metadata
  FROM incoming i
  WHERE NOT EXISTS (SELECT 1 FROM conflicts c WHERE c.id = i.id)
  ON CONFLICT (tenant_id, id) DO NOTHING
  RETURNING id
)
SELECT (SELECT array_agg(id) FROM conflicts) AS conflicting_ids,
       (SELECT count(*)::int FROM inserted) AS inserted_count;
```

No servidor TS:

```ts
const { conflicting_ids, inserted_count } = await rawExec(sql, [...arrays])
if (conflicting_ids?.length) {
  throw new TRPCError({ code: 'CONFLICT', message: `Conflicting session(s): ${conflicting_ids.join(', ')}` })
}
```

### Para a checagem de objeto (`assertRemoteObjectCatalog`)

Mesma estrutura: bulk SELECT por `object_id = ANY($1)` → comparar localmente → falhar se algum hash/size/storage_key diverge.

### Para `attachTenantObject`

Já é bulk-able trivialmente:

```sql
INSERT INTO tenant_object (tenant_id, object_id, first_batch_id, ref_count)
SELECT $1, t.id, $2, 1
FROM unnest($3::text[]) AS t(id)
ON CONFLICT (tenant_id, object_id) DO NOTHING;
```

### Para o manifesto (`sync_batch_*_manifest`)

INSERT bulk simples via `unnest`. Sem ON CONFLICT (linhas novas a cada batch).

## Impacto esperado

| Tabela                              | Queries antes | Queries depois | Notas                                     |
| ----------------------------------- | ------------- | -------------- | ----------------------------------------- |
| `remote_object` (assert + insert)   | 2N            | 2              | 1 bulk SELECT + 1 bulk INSERT/ON CONFLICT |
| `tenant_object`                     | N             | 1              | INSERT/ON CONFLICT em bulk                |
| `sync_batch_object_manifest`        | N             | 1              | (já é insert puro — só faltava unnest)    |
| `projection_session`                | 2M_s          | 2              | bulk SELECT conflicts + bulk INSERT       |
| `source_file`                       | 2M_sf         | 2              | idem                                      |
| `raw_record`                        | 2M_rr         | 2              | idem                                      |
| `search_doc`                        | 2M_sd         | 2              | idem                                      |
| `sync_batch_projection_manifest`    | M             | 4 (por tipo)   | INSERT bulk                               |
| **Total por commit (worst-case)**   | **45 000**    | **~16**        | **2800× redução**                         |

## Riscos e armadilhas

- **Preservar semântica de CONFLICT**: o teste atual (`apps/api/test/sync.test.ts`) cobre divergência de valores. A CTE de `conflicts` precisa replicar exatamente os predicados do `insertOrVerifyRow` — em especial `stableJson` (para JSON) e `normalizeTimestamp` (para ISO strings).
  - **JSON**: armazenado como `jsonb`. `IS DISTINCT FROM` no PG compara `jsonb` por valor canônico (ordem-independente). Equivalência semântica preservada.
  - **Timestamp**: armazenado como `timestamptz`. Pre-normalize na CLI (já é ISO string) e passe como `timestamptz` no `unnest` — o PG normaliza automaticamente.
  - **`raw_record.payload`**: o código atual chama `normalizeRawRecordPayload` para descartar `importBatchId` antes da comparação. Replicar essa normalização **no cliente** antes de enviar OU no servidor com `payload - 'importBatchId'` (jsonb minus key) na CTE.
- **Mensagens de erro menos específicas**: hoje cada `assertSameField` aponta o campo divergente; o bulk path retorna só IDs. Mitigação: incluir os IDs na mensagem e deixar o usuário rodar uma query de diagnóstico — ou retornar o primeiro campo divergente do primeiro ID via segunda query.
- **Transação maior, lock window mais curta**: bulk INSERT pega lock breve em muitas linhas. Como já estamos dentro da mesma transação Postgres, latência total cai e contenção *diminui* — não aumenta.
- **`unnest` com arrays grandes**: PG aceita arrays de centenas de milhares sem problema. 10 000 linhas é trivial.

## Como validar

1. **Manter testes verdes**: `apps/api/test/sync.test.ts` (commit happy-path) e o caso de conflito de metadados precisam passar inalterados.
2. **Novo teste de regressão**: enviar 10 000 linhas onde 1 % diverge → conferir que retorna CONFLICT com o ID exato.
3. **Benchmark**: `EXPLAIN ANALYZE` da query bulk vs. medir wall-clock de 10 commits seriais antes/depois.
4. **Trace de queries**: ligar log de queries no PG (`log_statement = 'all'`) e contar — deve cair de ~30 000 para ~10 por commit.

## Dependências e ordem

- **Independente de #01** — pode landed na mesma PR ou separado.
- **Bloqueia #03** (paralelismo de batches no cliente): sem isso, batches paralelos só amplificariam contenção PG por transações enormes.

## Prior art

- PostgreSQL idiom canônico: [Lukas Eder — "Batch INSERT with UNNEST"](https://blog.jooq.org/postgresql-unnest-could-be-just-as-fast-as-arrays/).
- ClickHouse recomenda inserts de 10k–100k linhas em uma transação ([clickhouse.com/docs/optimize/bulk-inserts](https://clickhouse.com/docs/optimize/bulk-inserts)).
