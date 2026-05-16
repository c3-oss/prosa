# 10 — Métricas por fase + progress bar fásica (UX percebida)

**Tier**: 4 (não acelera, mas muda a percepção) · **Onde**: cliente (com pequena ajuda do servidor) · **Impacto estimado**: zero de wall-clock; muito ganho de confiança e diagnóstico · **Esforço**: S-M

## Resumo

O memo cita: *"o usuário vê centenas de batches antes de qualquer dado de projeção estar totalmente aplicado"* e *"a fase inicial imprime muitos commits com `objects=0 rows=0`, o que parece progresso vazio e reduz confiança"*. O sync **é** progresso — só não comunica isso. Adicionar **timing por fase** (`plan / upload / commit / verify`), **throughput agregado** (objects/s, rows/s, bytes/s), e **barra de progresso fásica** ("verifying existing objects 167/167 ▓▓▓▓▓ → uploading missing bytes 0/0 ✓ → promoting projection rows 280k/1.1M ▓▓░░░") transforma "281 commits vazios" em "fase 1 concluída, fase 3 em andamento".

## Diagnóstico atual

`apps/cli/src/cli/commands/sync.ts:345-349, 373-375`

```ts
if (verbose) {
  process.stdout.write(
    `plan ${label} • batchId=${plan.batchId} declaredObjects=${casObjects.length} missingObjects=${plan.missingObjectIds.length} rows=${projectionRowCount(projection)}\n`,
  )
}
// ...
if (verbose) {
  process.stdout.write(`commit ${label} • objects=${commit.committedObjects} rows=${commit.committedRows}\n`)
}
```

Sintomas:
- Sem `--verbose`: nenhum feedback até o fim. Para 281 batches num sync de 30+ min, parece travado.
- Com `--verbose`: enxurrada de linhas planas, sem timing, sem agregação, sem ETA, sem distinção entre fases.
- Mensagens como `commit object batch 5 • objects=0 rows=0` literalmente parecem ruído ("estou commitando, mas não há nada para commitar?"). Tecnicamente é a validação de que os objetos já estavam no servidor — mas isso não é claro.

## Mudança proposta

### (a) Timing por fase, capturado em `promoteChunk`

```ts
type PhaseTimings = {
  planMs: number
  uploadBytesMs: number
  commitMs: number
  verifyMs: number
  totalMs: number
  bytesSent: number
  objectsDeclared: number
  objectsMissing: number
  rowsCommitted: number
}

async function promoteChunk(...): Promise<{ receipt: PromotionReceipt; timings: PhaseTimings }> {
  const t0 = Date.now()
  const plan = await client.syncPlanUpload({ ... })
  const t1 = Date.now()

  const missingObjects = casObjects.filter(...)
  let bytesSent = 0
  await mapConcurrent(missingObjects, OBJECT_UPLOAD_CONCURRENCY, async ({ entry, bytes }) => {
    bytesSent += bytes.length
    await client.uploadObjectBytes({ ... })
  })
  const t2 = Date.now()

  const commit = await client.syncCommitUpload({ ... })
  const t3 = Date.now()

  const verify = await client.syncVerifyPromotion({ ... })
  const t4 = Date.now()

  return {
    receipt: verify.receipt,
    timings: {
      planMs: t1 - t0, uploadBytesMs: t2 - t1, commitMs: t3 - t2, verifyMs: t4 - t3,
      totalMs: t4 - t0,
      bytesSent,
      objectsDeclared: casObjects.length,
      objectsMissing: plan.missingObjectIds.length,
      rowsCommitted: commit.committedRows,
    },
  }
}
```

### (b) Agregador + ETA

```ts
class SyncTelemetry {
  private samples: PhaseTimings[] = []
  private start = Date.now()
  totalEstimatedBatches: number

  record(t: PhaseTimings) { this.samples.push(t); this.render() }
  p50(getter: (t: PhaseTimings) => number): number { /* rolling p50 last 20 samples */ }
  etaMs(): number {
    const done = this.samples.length
    const remaining = this.totalEstimatedBatches - done
    return remaining * this.p50((t) => t.totalMs)
  }
  render() {
    const elapsed = Date.now() - this.start
    const eta = this.etaMs()
    process.stdout.write(
      `\rbatches ${this.samples.length}/${this.totalEstimatedBatches} • ` +
      `elapsed ${fmtDuration(elapsed)} • ETA ${fmtDuration(eta)} • ` +
      `plan p50 ${this.p50(t => t.planMs)}ms • commit p50 ${this.p50(t => t.commitMs)}ms`,
    )
  }
}
```

### (c) Barra fásica

Após o handshake, mostrar as 3 fases distintas:

```
✓ verifying existing objects  167/167  (0 needed upload, 23s)
✓ uploading missing bytes       0/0
↻ promoting projection rows  280K/1.1M  ▓▓▓▓▓▓▓░░░░░░░  ETA 4m12s
  └ source_files     ✓     3.1K/3.1K
  └ raw_records      ↻   180K/811K       ▓▓▓░░░░░░░░░
  └ sessions         ⏳         /3.1K
  └ search_docs      ⏳         /291K
```

Implementação: usar `ink` (já dependência? checar `apps/cli/package.json`) ou `cli-progress`/`ora` para spinner + bar simples. Sem ANSI escape: fallback para uma linha por minuto.

### (d) JSON event stream (opcional, com `--events-json`)

Para CI/automação: emitir uma linha NDJSON por batch:

```json
{"ts":"2026-05-15T12:01:11Z","event":"batch","kind":"object","seq":5,"total":281,"timings":{"planMs":2100,"uploadBytesMs":0,"commitMs":340,"verifyMs":80}}
```

### (e) Output final (não-verbose)

```
sync ok • batches=281 • elapsed 3m12s • peak 8 in-flight
phase timings (p50/p99):
  plan          230ms / 4.1s
  upload bytes  0ms / 12ms    (no missing objects)
  commit        140ms / 890ms
  verify        45ms / 110ms
```

## Impacto esperado

| Métrica       | Antes                             | Depois                              |
| ------------- | --------------------------------- | ----------------------------------- |
| Wall-clock    | inalterado                        | inalterado                          |
| Usuário sabe… | apenas que terminou               | onde está, ETA, qual fase é gargalo |
| Debug         | "está travado?" → kill -9         | "plan p99 = 4s" → vai direto a #01  |
| CI            | sem checkpoints                   | NDJSON estream → dashboards         |

A mudança subjetiva é tão grande quanto a real. *Não* é decorativo — sem isto, otimizar #01-#09 fica difícil de medir.

## Riscos e armadilhas

- **stdout poluição**: rendering com `\r` quebra em pipes não-TTY. Detectar `process.stdout.isTTY`; cair para linha por minuto.
- **Performance overhead**: `Date.now()` chamado 5×/batch = irrelevante. P50 rolling sobre 20 amostras = O(20).
- **Concorrência (com #03)**: barra precisa ser thread-safe (rolling buffer compartilhado). Renderizar a partir de uma única "tick" loop a cada 250 ms, não por evento.
- **ETA instável no começo**: nos primeiros 5 batches, ETA oscila muito. Mostrar `—` até ter ≥ 5 amostras.
- **Adoção**: respeitar `--json` (silencia output humano) e `--verbose` (mantém comportamento atual em paralelo, com timings).

## Como validar

1. **Visual smoke**: rodar `prosa sync` em um terminal real e ver a barra atualizar.
2. **CI**: rodar com `--events-json` e validar que cada batch produz exatamente 1 linha NDJSON parseável.
3. **Não-TTY**: redirecionar para arquivo, validar que não tem `\r` ou ANSI escape.
4. **Cancelamento**: SIGINT durante o sync deve imprimir o resumo parcial limpo (`finally` block).

## Dependências e ordem

- **Independente** de tudo — pode ser implementado em paralelo a qualquer outro item.
- **Pré-requisito para validar #01–#04**: sem timing por fase, mensurar ganho é fricção pura.

## Prior art

- **rsync `--progress`**: fase + rate + ETA em uma linha por arquivo.
- **`docker pull`** layered progress: múltiplas barras simultâneas, uma por layer.
- **`pnpm install`**: spinner + count of packages resolved/fetched/built/linked.
- **`cargo build`**: phase headers + counts.
- **OpenTelemetry traces**: cada fase como span — pode ser emitido junto se houver collector configurado.
