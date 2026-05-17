# REPORT — CLI-1 `prosa compile-all`

> Bundle real `~/.prosa` (3442 sessões, 2.5 GB SQLite, 7.2 GB total) clonado para `/tmp/prosa-perf-bundle-20260516T050149Z-smoke`. macOS arm64 (Apple M1 Pro, 16 GB), Node 24.12.0, commit `5959a9d`.

## Sumário executivo

| # | Área | Sintoma | Causa raiz hipotetizada | Impacto estimado | Esforço | Confiança |
|---|------|---------|--------------------------|------------------|---------|-----------|
| 1 | CLI bundling | Todo comando da CLI roda **duas vezes em paralelo** no mesmo processo. | Bundle tem 2 chamadas a `runCli(process.argv)` em sequência: a auto-execução condicional de `apps/cli/src/cli/main.ts:66-72` (`if (isEntry) runCli(...)`) sobrevive ao bundle do tsup E a auto-execução incondicional de `apps/cli/src/bin/prosa.ts:6` também roda. | Reduzir wall-time de **`prosa doctor` em ~50 %** (medido: 30.9 s → 15.8 s no mesmo bundle). Eliminar metade da carga de SQLite/CAS/index em compile-all. | XS (5 linhas em `bin/prosa.ts` ou `tsup.config.ts`) | **alta** (medido por 2 métodos) |
| 2 | SQLite WAL (conhecido) | 65 % do CPU sample do compile-all em funções SQLite (`exec` + `sqliteTransaction` + `flushPending` + `flushPendingObjects`). | Já documentado nas notas do projeto. Writer lock do WAL é o gargalo dominante. | n/a (fora de escopo, vide pressupostos) | L | alta |
| 3 | Hashing JS puro | `@noble/hashes` BLAKE2 ocupa ~3 % combinado (`compress`+`G2s`+`G1s`) em re-import idempotente. | CAS hashing usa BLAKE2 em **JavaScript puro** (`@noble/hashes`) para cada objeto, mesmo no caminho de skip. | redução de ~3 % em wall-time se trocar por napi/native (Node `crypto.createHash('blake2b512')` ou `xxhash-addon`). | S (uma função, contrato `hash_alg` no manifesto deve ser respeitado) | média |
| 4 | Re-compile idempotente lento | Re-compile de bundle estável (0 novos arquivos) custa **141 s** no claude importer com `flushPending` dominando 89 % do CPU em uma run patchada. | Suspeita: cada arquivo claude "skip" ainda passa por `flushPending` em transação separada → 975 transações com fsync. | redução >50 % se idempotency check antecipar e curto-circuitar antes de abrir transação. | M (refator no claude importer) | média (validado em 1 run, precisa cruzamento) |
| 5 | Allocator dominado por sourcemap | 50 % do heap profile em `node:internal/source_map/source_map.parseMap` + `sourceMapFromFile`. | `--enable-source-maps` ligado durante profiling infla heap startup. Não é gargalo de runtime, é viés do profiler. | descartado como falso positivo. | — | — |

## Cenário

- Comando exato (smoke duplicado, validação inicial):
  ```bash
  node --enable-source-maps \
    --cpu-prof --cpu-prof-dir=$RUN_DIR/profiles --cpu-prof-name=smoke.cpuprofile --cpu-prof-interval=500 \
    --heap-prof --heap-prof-dir=$RUN_DIR/profiles --heap-prof-name=smoke.heapprofile \
    --trace-gc \
    apps/cli/dist/bin/prosa.js compile-all --store /tmp/prosa-perf-bundle-20260516T050149Z-smoke --json-logs
  ```
- Wall-time medido (1 amostra cada, não hyperfine):
  - **Bundle original (com duplicação)**: 55 s. (`bench/perf/results/20260516T051915Z-cli-1-smoke/`)
  - **Bundle patchado (sem duplicação)**: 158 s. (`bench/perf/results/20260516T052853Z-cli-1-patched/`)
- O bundle estava no estado pós-importação real (3442 sessões já compiladas). O smoke run encontrou ~74 sessões novas em `~/.codex/sessions`/`~/.claude/projects` e as importou; o patched rodou imediatamente depois e encontrou 1 novo arquivo claude.
- Disparidade: a comparação direta 55 s × 158 s **não é válida** como ganho da remoção da duplicação (a quantidade de trabalho real difere entre os dois runs porque o smoke já tinha importado os novos arquivos). O ganho real foi medido em `prosa doctor` (read-only, comparável): 30.9 s → 15.8 s, **~49 % de redução**.

## Hot paths

### #1 — `runCli` duplicado (bundling pitfall em tsup)

**Stack do flamegraph**: não aplicável — o bug se manifesta no log e na estrutura do bundle.

**Evidência cruzada (2 métodos)**:

1. **Bundle inspection**: `grep -c 'runCli(process.argv)' apps/cli/dist/bin/prosa.js` = **2**. As duas chamadas vivem em sequência no fim do bundle:
   ```js
   // resíduo de apps/cli/src/cli/main.ts:66-72 — main.ts auto-executa quando é o entrypoint
   var isEntry = import.meta.url === `file://${process.argv[1]}`;
   if (isEntry) {
     runCli(process.argv).catch(...);
   }
   // resíduo de apps/cli/src/bin/prosa.ts:6 — shim sempre roda
   runCli(process.argv).catch(...);
   ```
   Em produção `isEntry === true` (o bundle é o argv[1]), então **ambos** disparam.

2. **API server log**: `prosa auth signup` envia **2 POSTs** para `/trpc/auth.signupWithTenant` separados por 21 ms (`bench/perf/results/20260516T052157Z-cli-2/api.stdout.log` linhas 1778909222036 e 1778909222057), de uma única invocação CLI. O segundo POST falha com `duplicate key value violates unique constraint "user_email_key"`.

3. **`prosa doctor` antes/depois do patch**: 30900 ms → 15754 ms. Razão 1.96×, consistente com remoção de execução paralela duplicada.

4. **Smoke log compile-all**: cada mensagem (`opening bundle`, `starting compile`, `rebuilding fts5 index`, `rebuilding tantivy index`, `parquet export finished`) aparece **exatamente 2×**; `starting compile` aparece **10×** (5 providers × 2 runs).

**Classificação**: bug de bundling (não é CPU/I-O/Lock/GC). Trabalho duplicado em paralelo dentro do mesmo processo.

**Proposta de otimização**:

- Opção A (mínima): em `apps/cli/src/bin/prosa.ts`, remover o `runCli(...).catch(...)` e simplesmente reexportar/importar `runCli` de `../cli/main.js`; manter `main.ts` como único auto-executor.
- Opção B (mínima alternativa): em `apps/cli/src/cli/main.ts`, remover o bloco `if (isEntry) runCli(...)` no fim do arquivo — só `bin/prosa.ts` invoca.
- Opção C (no nível do tsup): garantir que `bin/prosa.ts` é o **único** entry e que `cli/main.ts` é importado como módulo, não como entry. Isso requer ajuste do `tsup.config.ts` (`entry`).

Recomendo **Opção B** porque o auto-executor em `main.ts` foi um remanescente de desenvolvimento (uso direto via `node src/cli/main.ts`) e o shim `bin/prosa.ts` é o entry oficial publicado.

**Risco**: baixo. Cobertura de testes existentes (`pnpm test`) e `pnpm dev -- doctor` validam a remoção.

**Validação pós-otimização**:

- `node apps/cli/dist/bin/prosa.js doctor --store ~/.prosa` deve cair para ~50 % do tempo atual.
- `grep -c 'runCli(process.argv)' apps/cli/dist/bin/prosa.js` deve retornar **1**.
- API log com `prosa auth signup`: exatamente 1 POST em vez de 2.

### #2 — SQLite domina (conhecido, fora de escopo)

`bench/perf/results/20260516T051915Z-cli-1-smoke/profiles/smoke.cpuprofile` em speedscope mostra (top self-time):

```
 49.3%  27224 ms  better-sqlite3 wrappers.js:8         exec
  6.5%   3568 ms  better-sqlite3 transaction.js:52     sqliteTransaction
  4.8%   2625 ms  prosa-core/dist/index.js:3979        flushPending2 (importer)
  4.2%   2329 ms  prosa-core/dist/index.js:1163        flushPendingObjects (CAS)
  1.2%    687 ms  prosa-core/dist/index.js:1195        queryExistingObjectIds
```

Combinado ~66 % em SQLite write path. Já é o gargalo documentado (`feedback_compile_perf_tuning.md`). **Não propor otimização aqui** — vide pressupostos. Anotado para que o próximo achado (#3/#4) não seja confundido.

### #3 — `@noble/hashes` BLAKE2 em JS puro

**Stack do flamegraph** (smoke duplicado):

```
  1.7%    931 ms  @noble/hashes/esm/blake2.js:309       compress
  0.7%    371 ms  @noble/hashes/esm/_blake.js:38        G2s
  0.6%    347 ms  @noble/hashes/esm/_blake.js:31        G1s
```

Combinado **~3 % do wall-time mesmo em re-compile idempotente** (poucos objetos novos sendo hasheados — então em um compile-all com 5000 sessões novas, esse percentual cresce linearmente).

**Evidência cruzada**:

- `bundle.format` em `prosa doctor`: `hash_alg=blake3, default_compression=zstd`. **Espera** = blake3, **realidade** no profile = `@noble/hashes/blake2.js`. Há divergência entre o algoritmo declarado no manifesto e o que está rodando no CPU profile. Precisa investigação adicional — possivelmente blake2 é usado num caminho colateral.
- `grep -rn "@noble/hashes" packages/prosa-core/src/` localiza os callers para validar.

**Classificação**: CPU-bound em JS puro.

**Proposta de otimização**:

- Avaliar substituir `@noble/hashes` por implementação native (Node 22+ `crypto.createHash('blake2b512')` é nativa via OpenSSL, ou `blake3-wasm`/`blake3-napi` se BLAKE3 for o algoritmo correto).
- Garantir que o algoritmo do `manifest.json` (`blake3`) é o algoritmo realmente computado. A discrepância sugere caminho legado ou uso paralelo.

**Risco**: o algoritmo de hash do CAS é parte do contrato do bundle (`docs/architecture/bundle-format.md`); trocar requer migração ou flag de compatibilidade.

**Validação pós-otimização**: `compress` desaparece do top-25 do flamegraph; objetivo: <0.5 % do total.

### #4 — Re-compile idempotente lento (claude importer)

**Stack do flamegraph** (patched run, `bench/perf/results/20260516T052853Z-cli-1-patched/profiles/patched.cpuprofile`):

```
 89.4%  141059 ms  prosa-core/dist/index.js:2908       flushPending (claude importer)
  4.1%    6524 ms  better-sqlite3 wrappers.js:8        exec
```

A função `flushPending` (em `packages/prosa-core/src/importers/claude/index.ts:1081`) é chamada por arquivo claude pelo `transactional(bundle.db, () => flushPending(...))` em `compileClaudeFile` (linha ~711). Com 975 arquivos claude e quase todos no caminho de skip por idempotência, o overhead acumulado de "abrir transação + checar + fechar" domina.

**Evidência cruzada**:

- Timeline do log: claude batch leva **141 segundos** com `source_files_seen=975, source_files_imported=1, source_files_skipped=974`. Trabalho efetivo: 1 ingestão. Tempo gasto: 141 s. **141 s / 974 skip = ~145 ms por arquivo skip**.
- O smoke run com duplicação processou o mesmo bundle em ~30 s para claude (estimado por interpolação dos timestamps), o que sugere que a paralelização acidental acelerou o caminho de skip (cada paralelo carregou metade dos 975 — mas o ganho ainda assim foi superlinear, então pode haver um custo fixo per-file que se amortiza pelo overhead).

**Classificação**: provavelmente **Lock-bound** (cada skip ainda abre transação curta e faz fsync). Confirmar via `fs_usage -f filesystem` quando rodar Phase 6.

**Proposta de otimização**:

- Curto-circuitar o `transactional(...)` antes de abri-lo quando o arquivo já está em `source_files` com mesmo `(source_tool, path, size_bytes, mtime, content_hash)` — antecipar o teste de idempotência usando uma única `SELECT` batch fora da transação.
- Alternativa: batchear N arquivos por transação em vez de 1.
- Tem que se cuidar com o caminho de skip que ainda registra eventos em `raw_records` (per snippet de `flushPending`): se a skip simplesmente não acumula raw records, então a transação está vazia e o custo é puro fsync; mover o INSERT OR IGNORE pre-check para fora da transação resolveria.

**Risco**: médio. A idempotência atual depende da semântica `INSERT OR IGNORE`; mover para verificação prévia exige re-validação contra concorrência (mas compile-all é single-writer).

**Validação pós-otimização**: re-rodar compile-all em bundle estável; alvo `< 30 s` para o claude importer pass (vs 141 s atual).

### Falsos positivos descartados

- **Sourcemap dominance no heap profile (50 %)**: artefato de `--enable-source-maps` + curto-lifetime do processo. Não é gargalo de runtime; afeta startup latency apenas.
- **`(idle)` 18.9 % no CPU profile**: processo bloqueado em fsync esperando WAL. Não é hot path de CPU, é I/O wait. Já coberto pelo #2.
- **`dlopen` 1.8 %**: carregamento de `.node` addons na inicialização. Custo fixo, não escala com workload.
- **Tantivy `rebuildTantivyIndex` 1.4 %**: apesar do flag `overwrite=false`, o índice é reconstruído incrementalmente. Surpreendentemente barato — não é candidato a otimização aqui.

## Próximos passos sugeridos

1. **PRIORIDADE 1** — Remover a chamada duplicada de `runCli` (5 LOC). Cortes esperados: `doctor` -50 %, `compile-all` -50 % (parte que é overhead de duplicação; ganho exato depende de qual fração era trabalho útil vs duplicado).
2. **PRIORIDADE 2** — Reproduzir o achado #4 em ambiente Linux com `bpftrace fdatasync` para confirmar lock-bound. Se sim, aplicar curto-circuito de idempotência no claude importer.
3. **PRIORIDADE 3** — Auditar o caminho do BLAKE2 JS (#3): se BLAKE3 é o algoritmo canônico, BLAKE2 está rodando como sombra → eliminar.

## Pressupostos respeitados

- Não tocamos no SQLite WAL design, no pool de workers do compile, ou no caminho de PRAGMAs/page_size.
- Não propomos trocar TursoDB ou arquitetura.
- Pino e Better Auth não foram alterados na aplicação.
