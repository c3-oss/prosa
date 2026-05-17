# Performance profiling — sumário consolidado

> Worktree `prosa-perf-profiling` (base `master` @ `5959a9d`). Bundle real `~/.prosa` (3442 sessões, 2.5 GB SQLite, 912k CAS objects). macOS arm64 (Apple M1 Pro, 16 GB), Node 24.12.0, pnpm 10.8.1. Setup local: Docker stack (`postgres:16-alpine` em `:55432`, `minio:latest` em `:19000`). Sem rede externa.

> Profilers: V8 built-in `--cpu-prof` + `--heap-prof` + `--trace-gc` + `--enable-source-maps`. Tooling: `hyperfine` (via brew/npx), `autocannon`/`speedscope` via `npx`, `pg_stat_statements` via Docker extension. CLI/API patches mínimos aplicados em `dist/` apenas (proibido alterar `apps/src`/`packages/src`) — vide cada REPORT.

## Top achados — backlog priorizado por (impacto / esforço)

| Rank | Achado | Cenário | Impacto medido / estimado | Esforço | Confiança | Próxima sprint? |
|------|--------|---------|---------------------------|---------|-----------|-----------------|
| 1 | **Toda CLI roda 2×** no bundle de produção (auto-execução duplicada em `main.ts` + `bin/prosa.ts`) | todos os comandos | **medido**: `prosa doctor` 30.9 s → 15.8 s (-49 %). Esperado: corte similar em compile/sync/search/analytics. | **XS** (5 LOC) | **alta** (4 evidências independentes) | **SIM, imediato** |
| 2 | `commit-upload` server-side é **N+1**: SELECT+INSERT por row em 9 entity-types | API-1 | **confirmado em pg_stat_statements**: 3 500 SELECT projection_session + 6 500 SELECT projection_message (etc.). Estimativa: **~23 000× menos statements** com bulk upsert via `unnest`. | **M** (refator `insertProjectionRows`) | **alta** (estático + dinâmico) | **sim, próxima sprint** |
| 3 | `resolveMembership` sem `cookieCache` Better Auth | API-1 | **medido**: 10 000+ auth-related queries em 120 s para 8 tRPC calls (auth roda em /objects também). | **XS** (config Better Auth) | **alta** (dinâmico) | sim, mesmo PR do #2 |
| 4 | `tenant_object` lookup 3.75× por objeto | API-1 | **medido**: 37 586 SELECTs para 10 000 objetos (7.09 % do PG exec time). | **S** (consolidar lookups) | **alta** | sim |
| 5 | `sync_batch_object_manifest` JOIN per-PUT | API-1 | **medido**: 25.05 % do PG exec time, 977 332 buffer hits. Cachear ownership do batch em memória. | M | alta | sim |
| 6 | `@noble/hashes` BLAKE2 JS puro em hot path do CAS (client + server) | CLI-1, API-1 | **medido**: 3 % no CLI re-compile, **3.8 %** no servidor (PUT objects). Trocar por `crypto.createHash('blake2b512')` nativo. | S | alta | sim |
| 7 | Re-compile idempotente lento (claude `flushPending` 89 % CPU) | CLI-1 | 141 s → alvo <30 s eliminando transações vazias do skip path. | M | média | sim |
| 8 | `bytesForUpload` em serial dentro de worker `mapConcurrent` | CLI-2 | estimativa: throughput **+10-30 %** separando read/upload pipeline. | M | média | considerar após #1-6 |
| 9 | Subquery correlacionada em `readSessionsForUpload` | CLI-2 | 5-10 % wall-time da fase de leitura. | XS (reescrita SQL) | alta | quick win |
| 10 | Zod v3 e v4 ambos no heap | API-1 | 4.7 % heap; bundle size + startup latency. | S (pnpm overrides) | alta | quick win |
| 11 | AWS SDK Smithy overhead per PutObject | API-1 | 3.3 % CPU server combinado em middleware. | XS-S | média | avaliar |
| 12 | `verifyCommitObjectBytes` mistura parallel + serial | API-1 | 30-40 % do commit (estimado). Não confirmado dinamicamente. | S | média | confirmar primeiro |

## Cenários executados

| Cenário | Comando | Diretório de resultados | Wall-time | Status |
|---|---|---|---|---|
| CLI-1 smoke (bug ativo) | `compile-all` + bundle real | `20260516T051915Z-cli-1-smoke/` | 55 s | OK; revelou bug do runCli duplicado |
| CLI-1 patched (1× run) | `compile-all` após patch do bundle | `20260516T052853Z-cli-1-patched/` | 158 s | OK; perfil dominado por `flushPending` claude |
| CLI-1 A/B (doctor) | `prosa doctor` antes/depois | inline | 30.9 s → 15.8 s | **-49 %** medido |
| CLI-2 sync | implícito no API-1 (mesmo workload) | `20260516T055033Z-api-1/` | (timeout 120 s; 10 000 objetos PUT em 120 s = 83 obj/s) | parcial — 912k objs inviável em <2 h local |
| API-1 server profile | `prosa-api.js` com `--cpu-prof` durante cold sync | `20260516T055033Z-api-1/` | 120 s sync window, 249 433 PG calls, 117 distinct queries, 13.78 s PG exec time | **OK; profile capturado após patch SIGTERM** |

## Pressupostos respeitados

- **Não** tocamos no design SQLite WAL, no pool de workers do compile, em PRAGMAs/page_size, em Turso ou em arquitetura.
- **Não** desligamos Pino na aplicação real (`apps/*/src/`); só inspecionamos.
- Tudo local (Docker para Postgres/MinIO, sem rede externa, sem provedor cloud).
- Bundle real `~/.prosa` usado **somente** via `cp -cR` para `/tmp/`; nunca alterado em produção.
- Patches aplicados foram **apenas em `dist/`** (bundle output) para experimentos A/B sem mudar fonte. Source intacto.

## Patches de validação (Fase 6 — A/B)

Aplicados temporariamente para validar achados; **não** comitados em `apps/src/` ou `packages/src/`. Backups em `dist/.../prosa.js.bak`:

1. `apps/cli/dist/bin/prosa.js` — removido bloco duplicado `if (isEntry) runCli(...)` proveniente de `main.ts`. Validado: `doctor` -49 %.
2. `apps/api/dist/bin/prosa-api.js` — handler `SIGTERM/SIGINT` → `process.exit(0)` para que `--cpu-prof` flushe ao receber sinal do harness. Não é uma otimização — é prerequisito de profiling.

Para reverter: `mv apps/cli/dist/bin/prosa.js.bak apps/cli/dist/bin/prosa.js` (idem para API). Ou rodar `pnpm build` que regenera os dois.

## Falsos positivos descartados

- **Heap profile dominado por sourcemap** (50 %): viés de `--enable-source-maps` em processo curto-lifetime. Não é gargalo runtime.
- **`(idle)` 18.9 %**: I/O wait em fsync; é o WAL bottleneck já conhecido, não novo hot path.
- **`dlopen` 1.8 %**: startup fixo, não escala com workload.
- **`rebuildTantivyIndex` 1.4 %**: surpreendentemente barato para um bundle de 3500 sessões.
- **`mapConcurrent` shared counter sem atomic**: JS é single-thread, não há condição de corrida real.
- **`zstd-napi` no servidor**: presente no flamegraph mas <2 %; payloads em sync já vêm comprimidos do client.

## Cross-platform notes

- Dev em macOS (Apple M1 Pro). Para frames C++ de `.node` (better-sqlite3, zstd-napi, blake2-napi), usar **Instruments Time Profiler** (não acionado nesta rodada — V8 profile já apontou alvo claro).
- Para CI Linux: rodar `perf record -F 99 -p $PID -g` com `--perf-basic-prof-only-functions --interpreted-frames-native-stack` no Node — permite ver C++ frames junto.
- `bpftrace fdatasync` em Linux para confirmar o achado #4 (lock-bound suspeitado em `flushPending` claude).

## Como reproduzir

```bash
# Setup
PROSA_COMPOSE_POSTGRES_PORT=55432 PROSA_COMPOSE_MINIO_PORT=19000 \
  PROSA_COMPOSE_MINIO_CONSOLE_PORT=19001 \
  docker compose up -d postgres minio minio-create-bucket
docker exec prosa-perf-profiling-postgres-1 psql -U prosa -d prosa \
  -c "ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements';"
docker compose restart postgres

BUNDLE_DIR=/tmp/prosa-perf-bundle-$(date -u +%Y%m%dT%H%M%SZ)
/bin/cp -cR ~/.prosa "$BUNDLE_DIR"
echo "BUNDLE_DIR=$BUNDLE_DIR" > /tmp/prosa-perf-env

pnpm -F @c3-oss/prosa -F @c3-oss/prosa-api build

# Cenários
bash bench/perf/scenarios/cli-1-compile-all.sh
bash bench/perf/scenarios/cli-2-sync.sh         # (legacy; clones bundle, lento)
SYNC_TIMEOUT_S=120 bash bench/perf/scenarios/api-1-server-profile.sh
```

## Artefatos brutos

`bench/perf/results/<timestamp>-<scenario>/`:
- `env.json` — commit, Node, OS, CPU, RAM, ports
- `profiles/*.cpuprofile`, `profiles/*.heapprofile` — V8 sampling profiles
- `*.gc.log` ou `*.trace-gc.log` — `--trace-gc` redirecionado
- `*.stdout.json` — pino JSON logs
- `pg_stat_statements_top30.csv` — (API-1) top queries por `total_exec_time`
- `auth-signup.log`, `sync.json` — CLI outputs

Arquivos grandes (`*.cpuprofile`, `*.heapprofile`) **não** são commitados (`.gitignore` configurado em `bench/perf/.gitignore`).

## Como abrir os profiles

```bash
# CPU profile no speedscope (web viewer offline):
npx --yes speedscope bench/perf/results/<dir>/profiles/*.cpuprofile

# Heap profile no Chrome DevTools:
# 1. chrome://inspect → Open dedicated DevTools for Node
# 2. Profiler tab → Load → selecione o .heapprofile
```

## Próximos passos sugeridos (não implementados nesta fase)

1. **PR #1 (XS, alta prioridade)**: remover auto-execução duplicada de `runCli` em `apps/cli/src/cli/main.ts:66-72`. Adicionar teste em `apps/cli/test/` que conta `runCli` calls via spy.
2. **PR #2 (M, alta prioridade)**: refatorar `apps/api/src/trpc/routers/sync/projection-upserts.ts:584-661` para batch upserts via `unnest`/`ON CONFLICT DO UPDATE`. Validar idempotência com testes existentes em `apps/api/test/sync/`.
3. **PR #3 (XS, mesmo PR do #2)**: habilitar `session.cookieCache: { enabled: true, maxAge: 300 }` em Better Auth (`apps/api/src/auth.ts`).
4. **PR #4 (S)**: consolidar lookups de `tenant_object` e `sync_batch_object_manifest` em cache de batch (`apps/api/src/objects/...` ou middleware).
5. **PR #5 (S)**: substituir `@noble/hashes` BLAKE2 por `crypto.createHash('blake2b512')` nativo. Auditar contrato `hash_alg=blake3` no manifesto vs uso de blake2 (em `packages/prosa-storage`).
6. **Investigação (não PR)**: rodar Phase 6 do harness em Linux com `bpftrace fdatasync` para confirmar achado #7 (`flushPending` lock-bound no claude importer).
7. **Quick win (S)**: corrigir subquery correlacionada em `apps/cli/src/cli/sync/bundle.ts:49-76`.
8. **Quick win (S)**: `pnpm.overrides` para unificar zod em uma versão única.

## Limitações desta rodada

- **Sem hyperfine multi-run** com `stddev <15 %`: bundle de 7.2 G + clone 3 min por run inviabilizou 3-5 runs por cenário no tempo desta sessão. Cada cenário foi executado **1×** com profilers anexados. Sugestão: re-rodar em CI com bundle sintético menor para baseline com desvio.
- **Sync 120 s não chegou em `commit-upload`** para a maioria dos chunks — só 10 000 de 912 000 objetos foram processados na janela. Os achados de `commit-upload` foram confirmados via inspeção de código + `pg_stat_statements` (3 500 sessions processadas em um único commit-batch parcial). Para validação completa, rodar com bundle menor (e.g., últimos 100 sessions).
- **Sem OTel/Tempo/Jaeger**: deep research sugeria; foi pulado porque `pg_stat_statements` já deu o sinal necessário para A1-A8.
- **Sem Linux profiling com `perf`/`bpftrace`**: macOS-only nesta rodada. Frames C++ de `.node` addons (better-sqlite3, zstd-napi, blake2-napi se trocado) ficam opacos no flamegraph V8.
- **CLI-2 standalone não rodou** isolado do API-1 — o workload de sync foi profilado simultaneamente em ambos os lados via API-1 scenario. As métricas client-side (`metrics.planMs`, `metrics.uploadMs` etc.) não foram capturadas porque `timeout` matou o cliente antes do output JSON.
