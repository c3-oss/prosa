# Handoff — perf profiling do prosa (CLI + API)

Documento para quem precisa **continuar de onde paramos** ou **reproduzir os testes**. Cobre método, fixtures, ambiente, cenários, resultados, decisões de escopo, e o que sobrou no backlog.

Para o detalhe técnico de cada finding, ler:

- `bench/perf/results/REPORT-SUMMARY.md` — visão consolidada dos 12 findings originais.
- `bench/perf/results/REPORT-CLI-1.md` — CLI compile-all / doctor.
- `bench/perf/results/REPORT-CLI-2.md` — CLI sync (lado cliente).
- `bench/perf/results/REPORT-API-1.md` — API server durante sync.

Este HANDOFF.md cobre **como** chegamos lá — não **o que** encontramos.

---

## 1. Objetivo da investigação

Identificar gargalos de performance no prosa (CLI + API + sync end-to-end) usando profiling estático + dinâmico e produzir um backlog acionável com:

- Impacto medido ou estimado por correção.
- Esforço (XS / S / M / L).
- Confiança (alta / média / baixa).

Output esperado: PRs para corrigir os achados de alta + média confiança. Resultado real: **10 PRs abertas** (#37 a #45), **1 bloqueada** (#10 — zod overrides exige migração de `better-auth`), **1 deferida** (#7 — claude re-compile precisa repro em Linux com bpftrace).

---

## 2. Estado final dos PRs

Todas baseadas em `master`. Branches independentes, sem conflito entre si.

| PR | Branch | Finding(s) | Status |
|----|--------|------------|--------|
| [#37](https://github.com/c3-oss/prosa/pull/37) | `perf/cli-dedup-and-bundle-query` | #1 + #9 | aberta |
| [#38](https://github.com/c3-oss/prosa/pull/38) | `perf/auth-cookie-cache` | #3 | aberta |
| [#39](https://github.com/c3-oss/prosa/pull/39) | `perf/s3-keepalive` | #11 | aberta |
| [#40](https://github.com/c3-oss/prosa/pull/40) | `perf/commit-upload-batched-lookups` | #4 + #12 | aberta |
| [#41](https://github.com/c3-oss/prosa/pull/41) | `perf/manifest-batch-cache` | #5 | aberta |
| [#42](https://github.com/c3-oss/prosa/pull/42) | `perf/projection-batch-upserts` | #2 | aberta |
| [#43](https://github.com/c3-oss/prosa/pull/43) | `perf/blake3-wasm` | #6 | aberta — **31× speedup** medido |
| [#44](https://github.com/c3-oss/prosa/pull/44) | `perf/sync-read-pipeline` | #8 | aberta |
| [#45](https://github.com/c3-oss/prosa/pull/45) | `perf/find-missing-objects-batched` | #13 | aberta — **novo finding** do incidente "fetch failed" |
| — | `perf/zod-overrides` | #10 | **bloqueada** (`better-auth@1.6.11` usa `.meta()` v4-only em runtime) |
| — | — | #7 (claude re-compile) | **deferida** (fast-path já existe, precisa repro Linux) |

Esta branch (`perf/profiling-harness-and-baseline-reports`) **não é uma PR de código** — ela carrega só o harness e baselines pra reproduzir.

---

## 3. Ambiente

### 3.1 Repo / branches

- Worktree usado: `/Users/upsetbit/Projects/c3/c3-oss/prosa/.claude/worktrees/prosa-perf-profiling`
- Branch corrente: `worktree-prosa-perf-profiling` (criada a partir de `master` no início da investigação)
- Branch da PR aberta com harness: `perf/profiling-harness-and-baseline-reports`

> O worktree principal (`/Users/upsetbit/Projects/c3/c3-oss/prosa/`) **continua na branch de desenvolvimento normal do usuário** — o trabalho de perf foi isolado neste worktree.

### 3.2 Toolchain

| Ferramenta | Versão / fonte | Uso |
|------------|----------------|-----|
| Node | 24.12.0 (devbox shell) | runtime |
| pnpm | via corepack | install / scripts |
| Docker | desktop macOS | stack postgres+minio (alt ports) |
| Postgres | `postgres:16-alpine` (compose) | DB do API |
| MinIO | `minio/minio:latest` | object store local |
| `pg_stat_statements` | extensão criada no boot | métrica de PG |
| `hyperfine` | brew / `npx --yes hyperfine` | wall-time benchmark |
| `autocannon` | `npx --yes autocannon` | carga HTTP no API |
| `speedscope` / Chrome DevTools | local | inspecionar `.cpuprofile` |
| Node V8 profilers | flags nativas | `--cpu-prof`, `--heap-prof`, `--trace-gc`, `--enable-source-maps` |

### 3.3 Portas usadas

O usuário roda outro stack Docker (`rag_*`) e tinha um stack prosa "main" rodando no host. Para evitar colisão:

| Serviço | Porta padrão | Porta usada aqui | Var de env |
|---------|--------------|------------------|------------|
| Postgres | 5432 | **55432** | `PROSA_COMPOSE_POSTGRES_PORT` |
| MinIO | 9000 | **19000** | `PROSA_COMPOSE_MINIO_PORT` |
| API (compose) | 3000 | n/a (rodamos API standalone) | — |
| API (standalone) | 3000 | **30082** | `PROSA_API_PORT` |

> O API foi rodado **fora do compose** (com profile flags) para capturar `.cpuprofile` e `.heapprofile`. Os scripts de cenário sobem postgres+minio via compose mas startam o API com `node --cpu-prof ... apps/api/dist/bin/prosa-api.js` em background.

### 3.4 Subir o stack base

```bash
export PROSA_COMPOSE_POSTGRES_PORT=55432
export PROSA_COMPOSE_MINIO_PORT=19000
docker compose up -d postgres minio minio-create-bucket
```

Sanidade:

```bash
psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c "SELECT 1"
curl -sf http://127.0.0.1:19000/minio/health/live
```

### 3.5 Habilitar `pg_stat_statements`

Por padrão o postgres da imagem `postgres:16-alpine` **não** vem com `pg_stat_statements` em `shared_preload_libraries`. Foi habilitado manualmente:

```bash
docker exec <postgres-container-id> psql -U prosa -d prosa -c \
  "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';"
docker compose restart postgres

# Após restart:
psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"
```

Os scripts de cenário fazem `pg_stat_statements_reset()` antes da carga e `SELECT ... LIMIT 30 ORDER BY total_exec_time DESC` depois.

---

## 4. Stores / fixtures

### 4.1 Regra de ouro

**Nunca alterar `~/.prosa`** (instrução explícita do usuário). Para qualquer experimento, copiar o store antes e usar a cópia.

### 4.2 Bundle "smoke" — fixture principal

O bundle de origem é `~/.prosa` (~7.2 GB). Para clone barato no APFS:

```bash
SMOKE=/private/tmp/prosa-perf-bundle-20260516T050149Z-smoke
# BSD cp (macOS) suporta --clone via -c. devbox shell substitui cp por GNU,
# então usar /bin/cp explicitamente:
/bin/cp -cR "$HOME/.prosa" "$SMOKE"
```

> **Pegadinha**: `cp -c` no `cp` do devbox/coreutils retorna erro silencioso e cai pra cópia normal (lenta). Sempre invocar `/bin/cp` para usar o BSD cp do macOS, que aciona o `clonefile(2)` do APFS (cópia O(1) por arquivo).
>
> Mesmo com clonefile, **7.2 GB com muitos arquivos pequenos demora ~3 min** porque o overhead por arquivo domina.

### 4.3 Bundles dos subagentes (PRs)

Cada PR foi implementada por um subagente em **worktree isolado** (`isolation: "worktree"` do tool Agent). Esses worktrees têm seus próprios `node_modules` e estão em `~/.claude/worktrees/agent-<id>/`. Os IDs ficaram registrados nos relatórios de cada lança (não relevantes para reprodução).

### 4.4 Database

O Postgres da compose tem volume nomeado `prosa-postgres` (declarado no `docker-compose.yml`). Para começar do zero:

```bash
docker compose down -v   # remove volume!
docker compose up -d postgres minio minio-create-bucket
# re-habilitar pg_stat_statements (seção 3.5)
```

Cada cenário cria seu próprio usuário/tenant via `prosa auth signup` (emails únicos com timestamp), então re-rodar o mesmo cenário **acumula** dados — limpar o DB se quiser baseline limpo.

---

## 5. Patches reversíveis aplicados em `dist/`

Para destravar profiling sem precisar recompilar, dois patches foram aplicados **só nos artefatos `dist/`** (originais preservados como `.bak`):

### 5.1 `apps/cli/dist/bin/prosa.js.bak`

Backup do bundle ANTES de remover o bloco duplicado do `runCli` (finding #1). Permitiu medir A/B no `doctor`: 30.9 s (com bug) → 15.8 s (patched).

> A correção definitiva está na PR #37 (no source `apps/cli/src/cli/main.ts`). Esse `.bak` no `dist/` é só artefato local — está no `.gitignore`.

### 5.2 `apps/api/dist/bin/prosa-api.js`

Foi patched para registrar handlers de `SIGTERM`/`SIGINT` chamando `process.exit(0)`. Sem isso, o Node não flusha `.cpuprofile` quando o cenário manda kill. Trecho aplicado:

```js
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.once(sig, () => process.exit(0));
}
```

Como esse é o artefato `dist/` (gerado), também é descartável após `pnpm --filter @c3-oss/prosa-api build`.

> Se for ressuscitar o harness e os flush handlers tiverem voltado a faltar, repetir o patch ou propor uma PR adicionando esses handlers no source.

---

## 6. Cenários

Todos vivem em `bench/perf/scenarios/` e dependem das vars de ambiente exportadas (seção 3.3). Cada script:

1. Cria run dir: `bench/perf/results/<YYYYMMDDTHHMMSSZ>-<scenario-tag>/`
2. Chama `bench/perf/tools/collect-env.sh <run-dir>` que grava `env.json` (commit, Node, CPU, RAM, portas).
3. Roda o workload com flags de profiling.
4. Salva artefatos (`.cpuprofile`, `.heapprofile`, logs, dumps SQL) no run dir.
5. Anota `notes.md` com tempos medidos.

### 6.1 `cli-1-compile-all.sh`

Mede a CLI no caminho compile + doctor. Usa `hyperfine` com múltiplos runs e `prepare` clause limpando o store entre runs.

```bash
bash bench/perf/scenarios/cli-1-compile-all.sh
```

Outputs típicos:
- `smoke.stdout.json` / `patched.stdout.json` — saída JSON do CLI.
- `smoke.cpuprofile` / `patched.cpuprofile` — abrir no speedscope.
- `smoke.trace-gc.log` / `patched.trace-gc.log` — GC do V8.

### 6.2 `cli-2-sync.sh`

Sobe a API local, faz signup, e dispara um sync cold. `hyperfine` em torno do sync.

```bash
bash bench/perf/scenarios/cli-2-sync.sh
```

> **Pegadinha 1**: o primeiro signup falha com `duplicate key` se você não tiver limpado o DB — isso aconteceu durante a investigação e foi sintoma do bug #1 (CLI fazia 2 POSTs em paralelo). Após PR #37, não repete.
>
> **Pegadinha 2**: `sync --tenant <slug>` falha com "Active tenant required" — o server espera ID, não slug. O script pula o flag e deixa o `config.json` (gerado pelo signup) carregar o `activeTenant.id`.

### 6.3 `api-1-server-profile.sh`

Sobe a API com `--cpu-prof --heap-prof --trace-gc`, dispara um sync de carga, e captura `pg_stat_statements` no final.

```bash
SYNC_TIMEOUT_S=120 bash bench/perf/scenarios/api-1-server-profile.sh
```

Outputs:
- `profiles/server.cpuprofile` — abrir no speedscope para ver flame graph do server.
- `profiles/server.heapprofile` — análise de memória.
- `pg_stat_statements_top30.csv` — top 30 queries por `total_exec_time`.
- `pg_stat_statements_overview.csv` — totais agregados.
- `sync.json` / `sync.stderr.log` — saída do cliente.

> **Pegadinha**: `--trace-gc` não passa pelo allowlist do `NODE_OPTIONS` do prosa. Passar direto como flag do `node`, não via env. Ver o script para o pattern correto.
>
> **Pegadinha**: `SYNC_TIMEOUT_S` corta o cliente; com 912k objetos no `~/.prosa` o sync inteiro levaria horas. 120 s captura ~10k uploads e é suficiente para o profile. O cliente é morto via `timeout 120` → `sync.json` fica vazio mas os artefatos do server foram flushados (graças ao patch SIGTERM da seção 5.2).

### 6.4 `api-1-commit-upload.sh`

Variante focada em pressionar `commit-upload` (a fase mais cara segundo `pg_stat_statements`). Usa o mesmo padrão do 6.3 mas dimensiona pra ver o pico de inserts em projection_*.

---

## 7. Estrutura de `bench/perf/results/`

```
bench/perf/results/
├── REPORT-SUMMARY.md             ← visão consolidada (tabela de 12 findings)
├── REPORT-CLI-1.md               ← lane CLI compile/doctor
├── REPORT-CLI-2.md               ← lane CLI sync
├── REPORT-API-1.md               ← lane API server
└── <timestamp>-<scenario>/       ← um diretório por run
    ├── env.json                  ← snapshot do ambiente
    ├── notes.md                  ← anotações livres (tempos, decisões)
    ├── <name>.cpuprofile         ← V8 CPU profile (binário, IGNORED no git)
    ├── <name>.heapprofile        ← V8 heap profile (IGNORED)
    ├── <name>.trace-gc.log       ← GC log (IGNORED)
    ├── pg_stat_statements_*.csv  ← PG top queries (apenas API)
    └── <name>.stdout.json        ← saída JSON do comando
```

O `bench/perf/.gitignore` **exclui** todos os binários de profile e logs grandes para a branch ficar revisável. **O que está commitado** são os scripts, reports markdown, `env.json`, `notes.md`, `*.stdout.json` (pequenos), e os CSVs do `pg_stat_statements`.

Os runs preservados na branch:

- `20260516T051915Z-cli-1-smoke/` — baseline do CLI antes do patch do #1.
- `20260516T052853Z-cli-1-patched/` — CLI depois do patch local do #1.
- `20260516T055033Z-api-1/` — server profile + `pg_stat_statements` durante sync de 120s.

Para gerar novos runs sem perder os existentes, basta rodar de novo — o timestamp no nome do diretório evita colisão.

---

## 8. Os 13 findings (resumo + onde foi diagnosticado)

| # | Achado | Confiança | Como descobri |
|---|--------|-----------|---------------|
| 1 | `runCli` duplicado no bundle | alta | inspeção do `dist/` + grep `runCli(process.argv)` retornando 2; A/B com `doctor` |
| 2 | `commit-upload` N+1 (10 entidades × N inserts) | alta | `pg_stat_statements` mostrou 3.5k+6.5k SELECTs em projection_* |
| 3 | `resolveMembership` sem cache | alta | `pg_stat_statements` 10k+ `SELECT FROM session` em 120s |
| 4 | `tenant_object` lookup 3.75×/objeto | alta | 37.586 SELECTs `tenant_object` para 10k uploads |
| 5 | `sync_batch_object_manifest` JOIN per-PUT | alta | 25% do PG exec time num único query |
| 6 | BLAKE3 JS puro em hot path | alta | flame graph `server.cpuprofile`; 3.8% CPU server, 3% CLI |
| 7 | Re-compile idempotente claude lento | média | observação user; fast-path **já existe** mas algo está faltando |
| 8 | Read serial dentro do worker concorrente | média | leitura estática + entendimento de `mapConcurrent` |
| 9 | Subquery correlacionada em `readSessionsForUpload` | alta | grep + leitura de `bundle.ts` |
| 10 | zod v3 + v4 no heap | alta | `server.heapprofile` no speedscope |
| 11 | AWS SDK Smithy overhead | média | `server.cpuprofile`: 3.3% combinado em smithy/* |
| 12 | `verifyCommitObjectBytes` parallel + serial duplicado | média | leitura cuidadosa de `commit-upload.ts` + git log |
| 13 | `findMissingObjectIds` sequencial | alta | **incidente do usuário**: `planMs=124994` num chunk + `fetch failed` em cascata. Confirmado lendo `manifest.ts` |

Finding #13 não estava no profiling original porque o smoke bundle ainda não tinha rodado N planUploads grandes. Apareceu quando o user rodou sync real com `--reset-sync-checkpoint`.

### 8.1 Findings descartados como falso positivo

- `mapConcurrent` shared counter — JS é single-thread cooperativo, sem race.
- `zstd-napi compress` no sync client — maioria já está pré-comprimida no CAS local.

---

## 9. Decisões de escopo

Documentadas no plano em `~/.claude/plans/crispy-orbiting-lerdorf.md` e nos PRs.

| Decisão | Justificativa |
|---------|---------------|
| #6 — usar `hash-wasm` (WebAssembly), não trocar de algoritmo | Wire format do CAS depende do hash hex; trocar para SHA-256 quebraria todos os bundles existentes |
| #7 — fora desta sprint | Fast-path `registerSourceFile()` já existe; 141s/0 imports indica `mtime` change real. Precisa repro Linux + bpftrace |
| Múltiplas PRs por lane | User pediu — facilita merge paralelo, revisão isolada |
| #10 — não fechar a override | `better-auth@1.6.11` lança `z.coerce.boolean(...).meta is not a function` em runtime quando forçado pra v3. Migrar pra v4 envolve reescrever schemas em 3 pacotes |

---

## 10. Como continuar / próximos passos

### 10.1 Validar e mergeer as PRs abertas

Ordem sugerida (de menor para maior risco de regressão):

1. **PR #37** (CLI dedup) — XS, alta confiança, ~50% wall-time CLI.
2. **PR #38** (auth cache) — XS, alta confiança, elimina 30k queries auth.
3. **PR #45** (findMissingObjectIds batched) — XS, **conserta o `fetch failed` reportado**.
4. **PR #39** (S3 keep-alive) — XS, baixo risco.
5. **PR #43** (BLAKE3 WASM) — S, **31× speedup**, mas adiciona dep `hash-wasm`. Validar bundle size do CLI.
6. **PR #40** (commit-upload batched lookups) — S, remove código vestigial.
7. **PR #41** (manifest cache) — M, novo cache layer; revisar invalidation.
8. **PR #42** (projection batched upserts) — M, 11 funções novas; revisar conflict semantics.
9. **PR #44** (sync read pipeline) — M, refator de concorrência; revisar cancelamento.

### 10.2 Re-rodar baseline após merges

```bash
# Stack base
docker compose up -d postgres minio minio-create-bucket
# (re-habilitar pg_stat_statements se DB foi resetado)

# 3 cenários
bash bench/perf/scenarios/cli-1-compile-all.sh
bash bench/perf/scenarios/cli-2-sync.sh
SYNC_TIMEOUT_S=120 bash bench/perf/scenarios/api-1-server-profile.sh
```

Comparar com baselines em `bench/perf/results/20260516T*-*/`. Esperar:

- `doctor` wall-time: 30 s → 15 s (já validado pelo patch local; PR #37 reproduz).
- `commit-upload` p50: drop dramático (PR #42).
- `planMs` por chunk: 125 s → 2-5 s (PR #45).
- Top queries do `pg_stat_statements` mudam — manifest cache, projection bulk, tenant_object batched eliminam os top 3 atuais.

### 10.3 Atacar #10 (zod) propriamente

Caminho menos arriscado:

1. Pinar `better-auth` numa versão pré-`.meta()` (precisa investigar tag exata).
2. Manter zod v3 em pinning global.
3. Esperar `better-auth` estabilizar contrato peer / lançar versão sem v4-only deps.

Caminho ambicioso: migrar `apps/api`, `packages/prosa-core`, `packages/prosa-sync` para zod v4 (sintaxe `z.email()` em vez de `z.string().email()`, etc.).

### 10.4 Atacar #7 (claude re-compile) propriamente

1. Reproduzir o lentidão em Linux (CI runner) com bundle real.
2. `bpftrace`/`strace` para confirmar se é `fdatasync`, `fcntl`, ou outra syscall que custa.
3. Se for FS, considerar otimizações de WAL Postgres ou batching dos `INSERT OR REPLACE` em SQLite no `flushPending`.

Hipótese pessoal: `mtime` é alterado pelo backup do user → fast-path falha → reprocessa tudo. Verificar primeiro se `~/.prosa/sources/claude/**/*` tem `mtime` estável entre runs.

---

## 11. Riscos e armadilhas conhecidos

| Risco | Sintoma | Mitigação |
|-------|---------|-----------|
| `cp -c` silenciosamente vira cópia lenta | Bundle clone leva 30 min em vez de 30 s | Usar `/bin/cp -c` (BSD), não `cp` do PATH (GNU/coreutils do devbox) |
| `pg_stat_statements` não carrega | `ERROR: pg_stat_statements must be loaded` | `ALTER SYSTEM SET shared_preload_libraries` + restart do container |
| `NODE_OPTIONS` rejeita `--trace-gc` | Boot do Node falha com "unknown option" | Passar como flag direta do `node`, não via env |
| SIGTERM não flusha `.cpuprofile` | profile vazio ou truncado | Patch local do `prosa-api.js` (seção 5.2) ou usar `kill -USR2` se a flag estiver habilitada |
| Default `--batch-concurrency 4` satura PG pool (`max: 10`) | `fetch failed` + plan lento | Reduzir flags ou aplicar PR #45 |
| Subagente em worktree isolado faz `pnpm install` lento | Primeira run de cada agente custa ~30-60 s | Aceitar; usar `--prefer-offline` para acelerar |
| Run de cenário acumula no DB | Signup falha com `duplicate key` | `docker compose down -v` + re-criar extension |
| `sync.json` vazio quando `timeout` mata o cliente | Sem metrics no resumo do client | Olhar `sync.stderr.log` e `api.stdout.log` |
| Bundle real (`~/.prosa`) imutável | Qualquer flag que escreve quebra a regra | Sempre operar em cópia (`/private/tmp/prosa-perf-bundle-*`) |

---

## 12. Glossário de paths importantes

| Path | O que é |
|------|---------|
| `~/.prosa` | Bundle real do usuário — **READ-ONLY** |
| `/private/tmp/prosa-perf-bundle-20260516T050149Z-smoke` | Cópia clonefile usada nos cenários |
| `bench/perf/PLAN.md` | Plano inicial da Fase 0 (escopo + estratégia) |
| `bench/perf/README.md` | Guia curto de reprodução (pré-existente, neste handoff expandido) |
| `bench/perf/scenarios/*.sh` | Os 4 cenários de profiling |
| `bench/perf/tools/collect-env.sh` | Captura metadata do ambiente |
| `bench/perf/tools/perf-marks.mjs` | Observer de `performance.mark` (no-op até `PROFILE_MARKS=1`) |
| `bench/perf/results/REPORT-*.md` | Relatórios markdown por lane |
| `bench/perf/results/<ts>-*/` | Runs preservados |
| `~/.claude/plans/crispy-orbiting-lerdorf.md` | Plano detalhado das 9 PRs (gerado durante plan mode) |
| `apps/cli/dist/bin/prosa.js.bak` | Backup do bundle pré-patch do #1 (local, gitignored) |

---

## 13. Cheat sheet de execução (TL;DR)

Setup uma vez:

```bash
cd /Users/upsetbit/Projects/c3/c3-oss/prosa/.claude/worktrees/prosa-perf-profiling
git fetch origin
git checkout perf/profiling-harness-and-baseline-reports  # esta branch
pnpm install

export PROSA_COMPOSE_POSTGRES_PORT=55432
export PROSA_COMPOSE_MINIO_PORT=19000
docker compose up -d postgres minio minio-create-bucket

# Habilitar pg_stat_statements (uma vez, sobrevive a restart)
PG=$(docker compose ps -q postgres)
docker exec -it "$PG" psql -U prosa -d prosa -c \
  "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';"
docker compose restart postgres
psql -h 127.0.0.1 -p 55432 -U prosa -d prosa -c \
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;"

# Clonar o bundle
/bin/cp -cR "$HOME/.prosa" /private/tmp/prosa-perf-bundle-handoff

# Build dos artefatos da CLI / API
pnpm --filter @c3-oss/prosa build
pnpm --filter @c3-oss/prosa-api build
```

Rodar um cenário:

```bash
bash bench/perf/scenarios/cli-1-compile-all.sh
# ou
bash bench/perf/scenarios/cli-2-sync.sh
# ou
SYNC_TIMEOUT_S=120 bash bench/perf/scenarios/api-1-server-profile.sh
```

Inspecionar o resultado:

```bash
ls -la bench/perf/results/$(ls -t bench/perf/results | head -1)
# abrir .cpuprofile no speedscope:
#   https://www.speedscope.app/ → drag & drop o arquivo
```

Limpar e voltar pra zero:

```bash
docker compose down -v
rm -rf /private/tmp/prosa-perf-bundle-handoff
rm -rf bench/perf/results/<run-dir>   # se quiser remover runs
```

---

## 14. Quem fez o quê

- **Profiling original** (12 findings): execução manual de cenários + leitura de `.cpuprofile`, `.heapprofile`, `pg_stat_statements`. Tudo capturado em `bench/perf/results/`.
- **Plano de implementação** (9 PRs): `~/.claude/plans/crispy-orbiting-lerdorf.md`.
- **Implementação das PRs**: subagentes Claude Code em worktrees isolados (1 PR por subagent, paralelizados em 2 ondas).
- **PR #45** (finding #13): adicionada **depois** que o usuário reportou `fetch failed` mid-sync — root cause analysis ao vivo na sessão.

Ponto de continuidade: ler este HANDOFF, escolher uma PR aberta para revisar, e seguir o critério de aceitação descrito no body da PR. Se quiser re-rodar baseline, seguir a seção 13.
