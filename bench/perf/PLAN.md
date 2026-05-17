# Plano de execução — Fase 0

> Worktree: `prosa-perf-profiling` (base `master` @ `5959a9d`). Não tocar em `apps/` ou `packages/` (vide Fase 6 opcional). Tudo em `bench/perf/`.

## Ambiente

- macOS (darwin 25.5.0). Node **24.12.0** (devbox); o deep research mira Node 22, mas APIs de profiler V8 (`--cpu-prof`, `--heap-prof`, `perf_hooks`, `eventLoopUtilization`) são compatíveis. Anotar a divergência em cada `notes.md`.
- pnpm 10.8.1 via devbox. Docker 29.4.3 + Compose v5.1.3.
- macOS = sem `perf`/`bpftrace`. Substitutos: `sample(1)` (built-in), `fs_usage` (filesystem syscalls), Instruments Time Profiler (para frames C++ se necessário). Achados que exigem stackwalk em `.node` ficam marcados "validado apenas em Linux" com proxy macOS.

## Ordem dos cenários

1. **CLI-1 — `prosa compile-all` em bundle grande sintético.** Mais barato de iterar (1 processo, exit no fim).
2. **CLI-2 — `prosa sync` contra MinIO + API local (Docker).** Depende do servidor estar de pé.
3. **API-1 — `sync.commit-upload` + `sync.projection-upserts` sob carga concorrente.** wrk/autocannon contra API Docker.

Cenários "extras" se sobrar tempo: reads (`reads.*`) e `objects.ts` multipart. Marcados como **stretch**.

## Ferramentas por cenário

| Cenário | Wall-time | CPU profile | Async/eventloop | Heap | DB | S3/I-O |
|---|---|---|---|---|---|---|
| CLI-1 | `hyperfine -r 5` | `--cpu-prof` → speedscope | `--trace-gc`, ELU sample | `--heap-prof` (small vs large diff) | n/a | `fs_usage` (mac) para fsync rate em WAL |
| CLI-2 | `hyperfine -r 3` (mais lento) | `--cpu-prof` | `clinic bubbleprof` (await serial em `promotion.ts`) | `--heap-prof` | n/a (cliente) | AWS SDK middleware (per-op S3 latência) |
| API-1 | `autocannon -c 50 -d 60` + (opcional) `wrk2` | `--cpu-prof` em servidor | ELU sample + `--trace-gc` | snapshot diff t0 vs t60 | `pg_stat_statements` + `auto_explain` | AWS SDK middleware |

OTel opcional (Tempo/Jaeger local) apenas em API-1 se for necessário correlacionar spans. Para o primeiro pass, ficamos com `pg_stat_statements` + marks manuais.

## Fixtures

- **Bundle real read-only:** `~/.prosa` tem 3442 sessões e 2.5G de SQLite (7.2G total). Copiamos para `/tmp/prosa-perf-bundle-<ts>/` antes de cada cenário (regra: nunca tocar no bundle do usuário). Esse é o bundle "large".
- `bench/perf/fixtures/gen-compile.ts` — gerador determinístico (seed fixa) para sintetizar **bundles small/medium** (N=50, N=500) quando precisarmos isolar custo de import vs reindex.
- `bench/perf/fixtures/gen-payload.ts` — payload binário zstd-comprimido para `sync.commit-upload` (~4 MB), derivado do bundle real (sessão amostrada e re-encriptada).

## Artefatos

Tudo em `bench/perf/results/<UTC-timestamp>-<scenario>/`:

- `notes.md` — comando exato, commit hash, ambiente (OS/CPU/RAM), números brutos.
- `*.cpuprofile` — V8 CPU sampling.
- `*.heapprofile` — V8 allocation sampling.
- `*.gc.log` — `--trace-gc` redirecionado.
- `autocannon.json`, `hyperfine.json` — wall/throughput.
- `pg_stat_statements.csv`, `auto_explain.log` — Postgres profile.
- `s3-ops.ndjson` — middleware AWS SDK timings.
- `flamegraph.html` (gerado offline via `npx -y speedscope <cpuprofile>` quando necessário).
- `REPORT.md` — sumário, hot paths, propostas.

Adicionei `.gitignore` em `bench/perf/results/` para evitar commitar binários grandes (`.cpuprofile`, `.heapprofile`, SVG > 1MB).

## Pressupostos (do deep research e da memória do projeto)

- WAL writer lock do SQLite, pool de workers no compile, PRAGMAs + page_size=16K, Turso: **não re-investigar.** Buscar o próximo gargalo abaixo do WAL.
- Bench numérico = bundle de produção (tsup `--minify=false --sourcemap`), nunca dev/swc.
- Sourcemaps externos + `--enable-source-maps` obrigatórios.
- `PROFILE=1` ativa marks no-op por default (a adicionar em `bench/perf/tools/perf-marks.ts`; injeção via `--import` env-prefixed wrapper, sem tocar em `apps/`).

## Critérios de saída de cada fase

- **Fase 1 ok** quando: Docker stack saudável + ao menos um `node --cpu-prof dist/...` emitir `.cpuprofile` legível em speedscope.
- **Fase 2 ok** quando: 5 runs por cenário com `stddev/mean < 0.15`.
- **Fase 3 ok** quando: `.cpuprofile` + `.heapprofile` + (API) `pg_stat_statements.csv` salvos para os 3 cenários.
- **Fase 5 ok** quando: 1 `REPORT.md` por cenário + `REPORT-SUMMARY.md` consolidado, hot paths com **2 métodos** de evidência cada.

Fase 6 **só** se sobrar tempo, branch `perf/<achado>`, sem merge.

## Paralelização

- **Setup (Fase 1):** docker compose up (background), tsup build CLI+API (background), `cp -R ~/.prosa` (foreground rápido), instalação npx (sob demanda, sem global).
- **Profiling runs (Fase 3):** **sequenciais** — competir por CPU/I-O invalida números.
- **Drill-down (Fase 4):** delegar investigação de evidência em código a sub-agentes `Explore` em paralelo (um por hot path), retornando apontamentos para `apps/cli/src/...` e `apps/api/src/...`. A síntese fica comigo.
- **Relatórios (Fase 5):** um arquivo por cenário, escritos sequencialmente para evitar mismatch de números.
