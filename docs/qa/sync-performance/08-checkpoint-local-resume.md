# 08 — Checkpoint local persistente para retomada após interrupção

**Tier**: 3 · **Onde**: cliente · **Impacto estimado**: UX/robustez (zera retrabalho em crashes) · **Esforço**: S-M

## Resumo

Hoje, se o `prosa sync` morre no batch 140 de 281, a próxima execução **começa do zero**. O servidor é idempotente — re-envio de objetos/batches é seguro — mas o cliente revisita todos os batches anteriores, executando `planUpload` (com seu loop serial pesado) novamente. Para `~/.prosa`, isso significa **minutos a dezenas de minutos de retrabalho** em cada retry. Solução: persistir cursors + lista de batches já verificados em `<storePath>/.prosa-sync-checkpoint.json`, com TTL e invariantes claras.

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:399-461` — todos os cursores são variáveis locais:

```ts
let batchCount = 0
let lastReceipt: PromotionReceipt | null = null
let objectCursor: string | null = null

while (true) {
  const chunk = await readObjectChunk(bundle, storePath, objectCursor, maxObjectsPerPlan)
  if (chunk.casObjects.length === 0) break
  batchCount += 1
  lastReceipt = await promoteChunk({ ... })
  objectCursor = chunk.nextCursor
}
// ... similar para 4 tipos de projeção
```

Se `promoteChunk` falhar ou o processo for morto, `objectCursor`/`lastReceipt` desaparecem. Próximo `sync` começa em `objectCursor = null`. O servidor reaceita planos com objetos já existentes (`findMissingObjectIds` retorna `[]`), mas **todo o overhead de plan + commit + verify se repete por batch**.

Para o `~/.prosa` (281 batches): se cada batch revisitado custa ~5–30 s de overhead (planUpload serial, commit pequeno, verify), o retrabalho é da ordem de **15–90 minutos** mesmo sem subir um byte.

## Mudança proposta

### (a) Formato do checkpoint

Arquivo `<storePath>/.prosa-sync-checkpoint.json` (gitignore-able):

```json
{
  "version": 1,
  "sessionId": "01HXYZ...ULID",
  "storePath": "/Users/.../prosa",
  "server": "https://api.prosa.dev",
  "tenantId": "tenant_abc",
  "manifestSnapshotHash": "sha256:...",
  "createdAt": "2026-05-15T12:00:00Z",
  "updatedAt": "2026-05-15T12:14:33Z",
  "cursors": {
    "object": "blake3:abc...",
    "sourceFile": "sf_1234",
    "rawRecord": "rr_5678",
    "session": null,
    "searchDoc": null
  },
  "completedBatches": [
    { "batchId": "batch_111", "verifiedAt": "2026-05-15T12:01:11Z", "kind": "object", "rows": 0, "objects": 5000 },
    { "batchId": "batch_112", "verifiedAt": "2026-05-15T12:01:34Z", "kind": "object", "rows": 0, "objects": 5000 },
    ...
  ],
  "lastReceipt": { ... }
}
```

### (b) Snapshot do manifest local

`manifestSnapshotHash` é hash do `manifest.json` + count de cada tabela no SQLite local. Se o bundle local mudou desde o checkpoint (novos imports, compile, etc.), o checkpoint é **inválido** e descartado.

### (c) Write pattern

Atualizar após cada `verifyPromotion` bem-sucedido:

```ts
async function persistCheckpoint(storePath: string, state: CheckpointState): Promise<void> {
  const tmp = path.join(storePath, '.prosa-sync-checkpoint.json.tmp')
  const final = path.join(storePath, '.prosa-sync-checkpoint.json')
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, final)  // atomic on POSIX
}
```

Custo: ~10 KB write a cada batch (~5–30 s) — irrelevante.

### (d) Load + invariants no startup

```ts
async function loadValidCheckpoint(storePath: string, bundle: Bundle, server: string, tenantId: string)
  : Promise<CheckpointState | null> {
  const file = await readFile(path.join(storePath, '.prosa-sync-checkpoint.json')).catch(() => null)
  if (!file) return null
  const state = JSON.parse(file.toString())
  if (state.version !== 1) return null
  if (state.server !== server || state.tenantId !== tenantId) return null
  if (state.manifestSnapshotHash !== await computeManifestSnapshotHash(bundle, storePath)) return null
  const ageHours = (Date.now() - new Date(state.updatedAt).getTime()) / 3600_000
  if (ageHours > 24) return null  // TTL
  return state
}
```

### (e) Resume

`promoteChunkedUpload` aceita `resumeFrom?: CheckpointState`:

```ts
const checkpoint = await loadValidCheckpoint(storePath, bundle, server, tenantId)
if (checkpoint && options.verbose) {
  process.stdout.write(
    `resuming from checkpoint: ${checkpoint.completedBatches.length} batches already verified\n`,
  )
}

// Cursores começam do checkpoint ou null:
let objectCursor = checkpoint?.cursors.object ?? null
// idem demais cursores
```

### (f) Cleanup ao final

Após `verifyPromotion` final do último batch + (opcional) `removeLocalBundle`, apagar `.prosa-sync-checkpoint.json`.

### (g) Flag de override

```
--no-resume      ignore existing checkpoint and start over
--checkpoint <path>  custom checkpoint location
```

## Impacto esperado

| Cenário                         | Hoje                     | Com checkpoint        |
| ------------------------------- | ------------------------ | --------------------- |
| Crash no batch 140/281 + retry  | reinicia 281 batches     | retoma 141 batches    |
| Retry após 24h                  | reinicia                 | reinicia (TTL)        |
| Bundle modificado entre tentativas | reinicia (mas resync) | reinicia (snapshot mismatch) |

Não acelera o caminho feliz, mas elimina retrabalho em caminhos infelizes — crítico em redes flaky ou stores grandes.

## Riscos e armadilhas

- **Checkpoint stale**: se o servidor for limpo ou reiniciado, `batch_111` no checkpoint pode não existir mais. Solução: ao retomar, fazer um `sync.handshake` e considerar o checkpoint inválido se a versão do protocolo mudou ou se o server reportar receipt incompatível.
- **Lock entre processos**: dois `prosa sync` simultâneos lendo o mesmo checkpoint causa race. Solução: file lock (`proper-lockfile` ou similar) no `<storePath>/.prosa-sync.lock`.
- **Concurrent writes**: se #03 estiver ligado (paralelismo de batches), persistir checkpoint precisa ser feito atomicamente — só após todos os batches da "onda" verificarem. Ou persistir o pior-cursor (mínimo de todos os ranges em flight).
- **`storePath` read-only**: se o usuário rodar sync com bundle em local sem write permission, fall back para `~/.cache/prosa/checkpoints/<storeHash>.json`.
- **Falsa segurança**: o checkpoint não invalida se o server tiver perdido dados entre tentativas. Mitigação: o `verifyPromotion` final ainda re-checa a integridade global da last batch — se algo derivou, falha.

## Como validar

1. **Crash injetado**: matar `prosa sync` no batch 140; rerodar; verificar que retoma do 141. Confirmar via `--verbose` count.
2. **Bundle alterado**: rodar `sync` até a metade, importar mais dados localmente, rerodar — deve descartar checkpoint e reiniciar.
3. **TTL**: forjar `updatedAt` 25h no passado, verificar reinício.
4. **Lock**: spawnar dois `prosa sync` no mesmo store; o segundo deve falhar com erro claro.
5. **Cleanup**: completar sync com sucesso, confirmar que `.prosa-sync-checkpoint.json` foi removido.

## Dependências e ordem

- **Independente** de #01–#06; vale também na implementação atual (alivia retrabalho mesmo antes das otimizações).
- **Acoplado a #05**: se #05 reestruturar cursors (mix de tipos), o schema do checkpoint reflete a nova estrutura — fazer juntos.
- **Sinergético com #09** (idempotency keys): juntos permitem retries seguros pós-crash em qualquer ponto.

## Prior art

- **tus.io**: `Upload-Offset` header para retomada de uploads grandes ([tus.io/protocols/resumable-upload](https://tus.io/protocols/resumable-upload)).
- **rclone --checkpoint**: persistência de progresso para syncs grandes ([rclone.org/commands/rclone_sync/](https://rclone.org/commands/rclone_sync/)).
- **AWS CLI** `s3 sync` mantém `last-modified` cache local.
- **Backup tools** (restic, borg): index local + lock file é padrão.
