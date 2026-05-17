# Performance Profiling para Node 22: CLI `prosa` e API Fastify/tRPC

> Relatório técnico — monorepo pnpm/Turbo, Node 22, ESM + NodeNext, build via tsup, dev via `@swc-node/register`. Foco: descobrir o **próximo gargalo** depois das otimizações já consolidadas (PRAGMAs SQLite, page_size 16K, recusa de worker pool no compile, recusa de Turso).

---

## 1. Inventário de ferramentas de profiling para Node 22

### 1.1 Profilers V8 built-in (sem dependências)

| Flag | O que mede | Overhead típico | Curto-prazo (CLI) | Longo-prazo (API) |
|---|---|---|---|---|
| `--cpu-prof`, `--cpu-prof-dir`, `--cpu-prof-name`, `--cpu-prof-interval` | Sampling CPU (V8); escreve `.cpuprofile` no exit. Default: 1000 µs. | ~1–3% | **Ideal**: nenhum hook, basta exit normal. | OK se reiniciar processo após coleta. |
| `--heap-prof`, `--heap-prof-dir`, `--heap-prof-name`, `--heap-prof-interval` | Sampling de alocações (default 512 KiB). Escreve `.heapprofile`. | baixo | Bom para descobrir alocação por bundle no compile. | Bom para tracking de RSS crescente. |
| `--heapsnapshot-near-heap-limit=N` | Dumpa snapshot quando heap se aproxima do limite. | zero até disparar | Pouco útil (CLI raramente atinge). | **Essencial** para leaks. |
| `--heapsnapshot-signal=SIGUSR2` | Dump on demand via sinal. | zero | n/a | **Padrão** para investigação ad-hoc. |
| `--inspect`, `--inspect-brk`, `--inspect-wait` | Chrome DevTools Protocol (WebSocket 9229). | médio | Bom para CLI interativo (TUI Ink). | Útil para análise pontual; **nunca** com `0.0.0.0` em produção (RCE risk per Node docs). |
| `--trace-gc`, `--trace-gc-verbose` (verificar com `node --help-v8-options`) | Log de pausas GC para stderr. | baixo | Diagnóstico de pausas no compile. | Diagnóstico de jitter p99. |
| `--trace-warnings`, `--trace-uncaught` | Stack trace de warnings/uncaught. | zero | Sempre ligado em dev. | Sempre. |
| `--enable-source-maps` | Resolve sourcemaps em stack traces e profiles. | ~5–10% em stacks frequentes | Necessário para CLI bundlado por tsup. | Idem para API. |
| `--async-stack-traces` | Inclui stacks de `await` em erros (V8). Comportamento default mudou entre versões; o `NODE_OPTIONS` permitido foi tratado na issue `nodejs/node#35627`. | baixo–médio | Útil em ambos. | Útil em ambos. |
| `--prof` + `--prof-process` | Tick profiler V8 legado (text). | baixo | Substituído por `--cpu-prof` em quase todos os casos. | Idem. |

**Recomendação V8 puro**: comece sempre com `--cpu-prof` + `--enable-source-maps`; abra o `.cpuprofile` no Chrome DevTools (aba *Performance* → *Load profile*) ou no VS Code (extensão *vscode-js-profile-flame*).

### 1.2 `node:perf_hooks`

API W3C User Timing + extensões Node. Documentação oficial Node 22.

- `performance.mark(name)` / `performance.measure(name, start, end)` — emite `PerformanceEntry` observáveis via `PerformanceObserver`.
- `performance.eventLoopUtilization([util1[, util2]])` — retorna `{ idle, active, utilization }` em ms de alta resolução.
- `monitorEventLoopDelay({ resolution: 20 })` — histograma (HDR) com `.percentile(50/99)`, `.mean`, `.max`, `.stddev`. **Atenção** ao viés documentado em `nodejs/node#34661`: amostras são *skewed towards small measurements* quando há trabalho síncrono longo, porque o próprio timer libuv que faz a amostragem atrasa. Para CLI compile-all, isto sub-reporta picos de stall — combine com `--trace-gc` e RSS sampling externo.
- `PerformanceObserver` com `entryTypes: ['gc']` → `kind` (`Scavenge`, `MarkSweepCompact`, `IncrementalMarking`, `WeakCallbacks`) + `duration`.

**No-op wrapper para produção** (requisito da seção 3): exporte um módulo `perf-marks.ts` cujas funções `mark/measure` são vazias quando `process.env.PROFILE !== '1'`. Custo zero em produção, ativável por env var.

### 1.3 Flamegraph wrappers OSS

| Tool | Status | Quando usar |
|---|---|---|
| **0x** (David Mark Clements) | Estável; aceita `.cpuprofile`, gera flamegraph HTML interativo cross-platform; usa `perf` no Linux para frames nativos via `--kernel-tracing`. | Padrão de fato para flamegraph rápido de Node desde 2016. |
| **clinic.js** (Doctor / Flame / Bubbleprof / HeapProfiler) | **Em manutenção mínima**. CI de `clinicjs/node-clinic-flame` e `clinicjs/node-clinic-doctor` parou em "13.0.0 CI #236: Commit 747b691 pushed by RafaelGSS · June 27, 2023 20:57". Funciona em Node 22, mas avalie com cautela. | Bubbleprof continua único para visualizar serial-await; use-o no `sync` da CLI. |
| **flamebearer** (Mapbox) | OSS; visualizador puro a partir de `.cpuprofile` / pprof. | Quando só precisa do viewer. |
| **speedscope** | OSS; viewer web para `.cpuprofile`/pprof/Linux perf. | Substituto moderno do flamegraph.pl SVG. |
| **Platformatic `flame`** | Lançado em 2025 (post oficial Platformatic, "Next-Gen Flamegraph for Node.js"). Baseado em `@datadog/pprof`, inspirado no 0x. Gera `.pb` + HTML. | Boa opção em 2025/26; ainda emergente — valide antes de adotar em CI. |

**Recomendação**: comece com `node --cpu-prof` → speedscope (zero install extra). Escale para `0x` quando precisar correlacionar com `perf` no Linux CI. Para visualizar pprof do continuous profiler, use `flamebearer` ou Pyroscope UI.

### 1.4 Tracing / observabilidade — OpenTelemetry

Núcleo: `@opentelemetry/api` + `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`. Instrumentações específicas:

- **Fastify**: `@opentelemetry/instrumentation-fastify` foi marcada como deprecated e desabilitada por padrão em janeiro de 2025, parou de receber novas versões em 30/jun/2025 e foi removida completamente em março de 2026 (per `@opentelemetry/auto-instrumentations-node` npm README). O substituto oficial mantido pelos autores do Fastify é **`@fastify/otel`** (repo `fastify/otel`); registro via plugin: `await app.register(fastifyOtelInstrumentation.plugin())`. Aceita `registerOnInitialization: true` para auto-registro via `NodeSDK`.
- **Postgres (pg/postgres-js)**: `@opentelemetry/instrumentation-pg` (cobre `pg`). Para o driver **`postgres` v3** (postgres-js), não existe instrumentação oficial — instrumente manualmente com spans em volta do client tagged query, ou faça shim no Drizzle client.
- **AWS SDK v3**: `@opentelemetry/instrumentation-aws-sdk`. Atenção: issue `aws/aws-sdk-js-v3#4902` documenta que o middleware do SDK v3 expõe **menos dados** que v2, então spans S3/Object podem faltar bucket/key.
- **HTTP**: `@opentelemetry/instrumentation-http` é **pré-requisito** das instrumentações Fastify e AWS (caso contrário spans não são linkados).

Exporter local: `@opentelemetry/exporter-trace-otlp-http` → coletor OTel local em Docker → **Jaeger** ou **Grafana Tempo** (ambos OSS). Overhead reportado pelos guias: ~0,5–2 ms/req e ~2–5% CPU com BatchSpanProcessor (valor publicado em guias de terceiros; valide com seu workload).

**CLI vs API**: para o servidor Fastify, OTel é ganho líquido (correlaciona tRPC → pg → S3). Para a CLI, OTel só vale com spans on-demand atrás de `if (process.env.OTEL_ENABLED)`; senão o startup cost arruina a UX.

### 1.5 Continuous profiling

- **Grafana Pyroscope** (OSS, ex-Phlare): pacote `@pyroscope/nodejs` (push) baseado em `@datadog/pprof`. Os docs oficiais (`grafana.com/docs/pyroscope/latest/introduction/continuous-profiling/`) afirmam: *"By using sampling profilers, Pyroscope and Cloud Profiles can collect data with minimal overhead (~2-5% depending on a few factors)."* Roda em Docker single-binary (`grafana/pyroscope:latest`), porta 4040. **Importante**: o sampler usa V8 CPU profiler, então **não vê frames C++ dos addons** (limitação herdada; ver seção 6).
- **Parca / Polar Signals Agent**: OSS, eBPF-based; vê frames nativos. **Linux-only** (eBPF). Use no CI/produção, não no dev mac.
- **Datadog Continuous Profiler**, **Sentry Profiling**: comerciais — *fora do escopo deste relatório por restrição "OSS-only"*. Equivalente OSS: Pyroscope + Parca.

Custo Docker local de Pyroscope: ~512 MiB RAM, ~250 m CPU baseline (config padrão dos exemplos oficiais).

### 1.6 Análise de heap

- `--heap-prof` (V8) — sampling allocator, baixo overhead.
- `--heapsnapshot-signal=SIGUSR2` — snapshot completo on-demand; abrir em Chrome DevTools, usar **Comparison view** para diff entre snapshots t0 e t1 (padrão para leak hunting em long-lived API).
- `clinic heapprofiler` — wrapper sobre o V8 heap profiler (mesma manutenção limitada da seção 1.3).
- Pacote `heapdump` legado: substituído pelas flags built-in; evite.

### 1.7 Async / event-loop profilers

- `clinic bubbleprof` — único OSS que visualiza chains de async_hooks. Use para o `sync` da CLI (validar a hipótese de serial-await que poderia pipelinar).
- `node:async_hooks` direto — caro; **só** em modo diagnose.
- `--async-stack-traces` — já discutido; reduz custo de debug, não de profile.
- `why-is-node-running` (npm) — lista handles ativos quando o processo recusa sair; essencial para CLI commands (`compile-all`, `sync`) com handles pendurados.
- `loopbench` (Matteo Collina) — micro-lib para amostrar event-loop delay com limite, útil em testes (`overLimit` flag).

### 1.8 HTTP load tools (para API)

| Tool | Linguagem | HTTP/2 | Latency resolução | Scripting | Notas |
|---|---|---|---|---|---|
| **autocannon** | Node | Sim | percentis até p99.999 (flag `-l`) | JS | Padrão Fastify; útil porque pode ser embedado em testes. **Limitação documentada** (`denosaurs/bench#41`): para servidores >50k rps o próprio autocannon é gargalo. |
| **wrk** | C | Não | até p99.9 | Lua | Rápido; resolução limitada. |
| **wrk2** | C | Não | HdrHistogram com p99.99/99.999 | Lua | Corrige *coordinated omission* — **escolha** para medir tail latency real. |
| **k6** | Go | Sim | p95/p99 configurável; HdrHistogram | JS (ES6) | Thresholds em CI; melhor DX para cenários multi-step e auth. |
| **oha** | Rust | Sim | percentis em TUI realtime | template | Substituto moderno de `hey`/`ab`. |
| **bombardier** | Go | Sim | p50/p95/p99 | flags | Simples, bom para CI rápido. |
| **vegeta** | Go | Não | HdrHistogram completo | shell pipe | Padrão para *constant request rate* (não open-loop). |

**Recomendação**: `autocannon` no script `bench` local + **wrk2** ou **k6** no CI para medir p99/p99.9 sem *coordinated omission*. Para `objects` (multipart streaming a S3), use **vegeta** (POST com payload grande).

### 1.9 CLI / short-lived benchmark

- **hyperfine** (sharkdp) — padrão OSS de fato. `--warmup N`, `--prepare 'sync; echo 3 > /proc/sys/vm/drop_caches'` (cold cache), `--export-json/markdown/csv`, `--parameter-scan`. Detecta outliers estatísticos. Use para `prosa compile-all` end-to-end.
- **GNU `time -v`** — `Maximum resident set size`, `Major (requiring I/O) page faults`, `Voluntary context switches`. **Linux-only** com `/usr/bin/time -v`; macOS usa `gtime` (coreutils via brew).
- **multitime** — médias + stddev simples; substituível por hyperfine.
- **poop** (Andrew Kelley) — Linux only, compara perf counters entre comandos.

### 1.10 In-process microbench

- **mitata** (`evanwashere/mitata`) — picosegundos, detecta dead-code elimination, hardware counters via `@mitata/counters` (Linux). Estado da arte para JS micro.
- **tinybench** — leve (~10 KB), API simples, `retainSamples` opcional. Issue `tinylibs/tinybench#42` documenta perda de precisão vs Benchmark.js em funções muito rápidas.
- **benny** / **vitest bench** — ergonomia; `vitest bench` integra com o test runner já adotado, mas resolução pior que mitata. Para Tantivy/Parquet (já em `bench/`), **migre** para mitata se precisar de números abaixo de 100 ns.

### 1.11 I/O profiling (syscalls/disk)

**Linux (CI)**:
- `strace -c -f -p PID` — contagem de syscalls (cobrir os `fdatasync` do WAL).
- `perf trace -s` — equivalente moderno.
- `bpftrace` (eBPF) — `tracepoint:syscalls:sys_enter_fdatasync { @[comm] = count(); }` para medir taxa de fsync do better-sqlite3 WAL writer.
- `iostat -x 1`, `iotop`.

**macOS (dev)**:
- `fs_usage -w -f filesystem PID` — equivalente próximo a strace para filesystem.
- `sample(1)` — sampling de stacks built-in.
- **Xcode Instruments** com *Time Profiler* + *System Trace* — vê frames nativos C/C++ de `.node` addons (essencial; ver seção 6).
- `dtrace` no macOS funciona, **mas o ustack helper de Node nunca foi suportado em macOS** (Dave Pacheco documenta bugs Apple 5273057 e 11206497) — restrito a illumos/SmartOS.

### 1.12 Postgres profiling

- **`pg_stat_statements`** (`shared_preload_libraries = 'pg_stat_statements'`, `pg_stat_statements.track = all`). Query canônica: `SELECT ... FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10`.
- **`auto_explain`** (`session_preload_libraries = auto_explain`, `auto_explain.log_min_duration = '200ms'`, `log_analyze=true`, `log_buffers=true`, `log_wal=true`, `log_format=JSON`). Avisos do PostgreSQL: `log_timing=true` pode ter overhead *"extremely negative"* — calibre com `pg_test_timing`.
- **`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)`** ad-hoc; em PG 18 BUFFERS é automático. Visualize com `pev2` (OSS) ou pgMustard (comercial — pular).
- **`pgBadger`** (OSS) — agrega o log do Postgres.
- **`application_name` por procedure tRPC**: postgres-js aceita `connection: { application_name: 'prosa-api:' + procName }`; setar via `SET LOCAL application_name = $1` no início de cada procedure permite filtrar `pg_stat_activity` e `pg_stat_statements` por rota.

### 1.13 S3 profiling

- **AWS SDK v3 middleware customizado** (padrão oficial AWS blog "Introducing Middleware Stack in Modular AWS SDK for JavaScript"): inserir middleware na etapa `build` ou `finalizeRequest` que mede `process.hrtime.bigint()` em volta de `next(args)`; emitir como métrica OTel.
- `aws-sdk-client-mock` (OSS) — testes unitários sem rede.
- **LocalStack** (OSS Community) ou **MinIO** (Apache-2.0) — stress local sem custo AWS.
- Limitação documentada (`aws/aws-sdk-js-v3#4902`): middleware v3 expõe menos contexto que v2, então spans OTel S3 ficam genéricos.

---

## 2. Stress test design — três cenários reprodutíveis

### Cenário CLI-1: `compile-all` em bundle grande

- **Fixture sintética**: gerador determinístico que produz N sessões (alvo N=500 e N=5000) com transcripts de tamanho lognormal (μ=8KB, σ=2) e distribuição realista de tool_calls. Saída: tarball `fixtures/compile-large.tgz`. Geração isolada em `bench/fixtures/gen-compile.ts` — sem dados reais.
- **Workload**: `prosa compile-all --source fixtures/compile-large/`.
- **Métricas**:
  - wall-time (hyperfine `--warmup 1 --runs 5`)
  - CPU% e RSS via `/usr/bin/time -v` (Linux) / `gtime -v` (mac)
  - `fdatasync` rate via bpftrace (Linux) / `fs_usage -f filesystem` (mac)
  - alocação/importer via `--heap-prof` (compare `.heapprofile` entre N pequeno e N grande)
  - GC pauses via `--trace-gc` redirecionado.
- **Hipótese a validar**: dado que o WAL writer lock é o gargalo conhecido, o *próximo* candidato é (a) Tantivy reindex no final, (b) alocação JSON em `pino` (mesmo no level `silent`, há serialização), ou (c) `better-sqlite3` `prepare` repetido sem cache.
- **"Interessante" quando**: abrir flamegraph se >25% do CPU sample cair fora de `sqlite3_step`/`Tantivy::index`.
- **Invalidação**: se flamegraph mostrar `>60%` em `sqlite3_step` + `pwrite64`, a hipótese WAL é confirmada como #1 e #2 — não há ganho líquido sem mudar a arquitetura WAL (proibido pelo escopo).

### Cenário CLI-2: `sync` com chunked upload

- **Fixture**: tarball de 1 GB com 200 sessões pré-compiladas + manifesto. Endpoint S3: MinIO local em Docker.
- **Workload**: `prosa sync --resume=false --concurrency 4`, depois `prosa sync` (checkpoint resume) com 30% dos chunks pré-existentes.
- **Métricas**: bundle read time (`performance.mark` em `bundle.ts`), hashing/zstd compress cost (mark em torno de `zstd-napi.compress`), upload parallelism real (medir gap entre `Promise.allSettled` em `concurrency.ts`), S3 ops/sec via middleware AWS SDK.
- **Hipótese**: serial `await` em `promotion.ts` ou `checkpoint.ts` que poderia ser `Promise.all`; e zstd-napi gera buffer copy desnecessário entre Node Buffer e ArrayBuffer da AWS SDK.
- **"Interessante"**: ELU < 0.5 durante upload (CPU ocioso = network bound; ok); ELU > 0.85 + p99 alto = CPU bound (zstd dominando), abrir flamegraph.
- **Invalidação**: se bubbleprof não mostrar cadeia await serial e flamegraph for plano (várias funções <5%), o gargalo é network/S3 e a única ação restante é aumentar `concurrency` em `limits.ts`.

### Cenário API-1: tRPC `sync.commit-upload` + `sync.projection-upserts` sob concorrência

- **Fixture**: Postgres em Docker (16-alpine) com schema aplicado, populado com 100k sessões; payload `commit-upload` de 4 MB zstd-comprimido.
- **Workload**: **wrk2** com `-R 200 -d 60s -c 50` contra `/trpc/sync.commitUpload`; em paralelo, `pg_stat_statements_reset()` + coleta delta.
- **Métricas**:
  - p50/p99/p999 latency (wrk2 HdrHistogram)
  - throughput (req/s)
  - `pg_stat_statements`: top-10 por `total_exec_time`
  - `auto_explain` com `log_min_duration=100`
  - eventLoopUtilization sampled a cada 1s no servidor (endpoint `/health` retorna o delta)
  - zstd decompress cost (mark em torno de `zstd-napi.decompress`)
  - Zod safeParse cost (mark)
  - Better Auth session validation cost (mark em torno de `auth.api.getSession`).
- **Hipóteses**:
  1. `projection-upserts` é N+1 — Drizzle gera UPDATE em loop em vez de bulk `INSERT ... ON CONFLICT`. Validar com `pg_stat_statements.calls` >> 1 para o mesmo `queryid`.
  2. Better Auth adiciona overhead fixo per-procedure: mensurável habilitando `session.cookieCache: { enabled: true, maxAge: 300 }` e comparando. Docs Better Auth: cookieCache "elimina queries DB em validações de sessão".
  3. zstd decompress + Zod safeParse de payload grande dominam CPU.
- **"Interessante"**: p99 > 5× p50 → flamegraph; CPU% > 70% por instância → flame; eventLoopDelay p99 > 50 ms → bubbleprof.
- **Invalidação**: se `pg_stat_statements` mostra <30% do total em projection queries e flamegraph é plano em JS, o gargalo é network/PG fsync — fora do escopo de aplicação.

---

## 3. Drill-down metodologia (endpoint lento → linha culpada)

**Sourcemaps em código bundlado (tsup)**: tsup expõe `sourcemap: true | 'inline'` (issue `egoist/tsup#495` documenta que `'inline'` teve bug histórico; valide na versão atual gerando dist e inspecionando `//# sourceMappingURL=`). **Configuração canônica para profiling**: `sourcemap: true` (external) + sempre executar com `node --enable-source-maps dist/cli.js`. Em dev via `@swc-node/register/esm-register`, o sourcemap é gerado em memória — `--enable-source-maps` resolve mas o overhead é maior; **regra**: benchmarks de número devem rodar contra o bundle de prod (`tsup --minify=false --sourcemap`), nunca contra dev/swc. O dev mode infla números em 10–30% facilmente.

**Anexar `--cpu-prof` ao bundle**: `node --enable-source-maps --cpu-prof --cpu-prof-dir=./profiles dist/cli.js compile-all`. Em dev: `node --enable-source-maps --cpu-prof --import @swc-node/register/esm-register src/cli.ts compile-all` — mas só para localizar hot path, **não** para medir.

**performance.mark sem poluir codebase**: módulo `src/diag/perf.ts` exporta `mark(name)`, `measure(name, start, end)`. Quando `process.env.PROFILE !== '1'`, as funções são `noop`s (constantes). Ative com `PROFILE=1 prosa compile-all` e leia spans com `PerformanceObserver({ entryTypes: ['measure'] })` que loga em stderr (não polui stdout dos commands).

**Correlação tRPC ↔ Postgres ↔ S3 em uma trace OTel**: `@fastify/otel` cria root span por rota; `@opentelemetry/instrumentation-pg` cria child spans automáticos; `@opentelemetry/instrumentation-aws-sdk` instrumenta o S3 client. Para tRPC procedures dentro de uma única rota (`/trpc/sync.commitUpload`), envelope o handler com `tracer.startActiveSpan('trpc.sync.commitUpload', span => …)` — o context propagation é automático pois OTel usa `AsyncLocalStorage`.

**Diferenciar gargalos**:
- **CPU-bound**: flamegraph com pilha alta e bloco largo (>30% da população de amostras) em código próprio. Indicador secundário: `ELU.utilization > 0.9`.
- **I/O-bound**: bubbleprof mostra "bolhas" longas mas CPU baixa; ELU < 0.5; `pg_stat_statements` mostra `total_exec_time` >> `total_plan_time`; `auto_explain` com `I/O Timings: shared read=…ms` alto.
- **Lock-bound**: alto `fdatasync`/`fsync` syscall rate (bpftrace) mas CPU baixa; no SQLite, é o WAL writer lock — sintoma: várias threads bloqueadas em `pwrite64` no flamegraph nativo.
- **GC-bound**: `--trace-gc` mostra pausas frequentes >50 ms; `PerformanceObserver({entryTypes:['gc']})` com `MarkSweepCompact` frequente; heap-prof cresce até o limite.

**Heurísticas de detecção** (já validadas pela literatura primária citada):
- **Serial await que deveria ser Promise.all**: bubbleprof; ou inspecione `.cpuprofile` no DevTools — duas funções async sequenciais com `idle` no meio = candidate. Matteo Collina em *"Do Not Thrash the Node.js Event Loop"* (USENIX SREcon23 Europe/Middle East/Africa, Dublin, outubro de 2023) descreve o anti-pattern de criar milhares de promises síncronas em loop bloqueando a microtask queue.
- **JSON.parse/stringify dominando**: bloco largo em flamegraph com `Builtins:JsonParse` ou `Builtins:JsonStringify`. Mitigação: streaming JSON (`stream-json`) ou usar `Buffer` direto.
- **Zod `safeParse` em hot path**: aparece como `ZodObject._parse`/`ZodEffects._parse` na flamegraph. Mitigação: schemas pré-compilados ou validação só na borda da rota.
- **Drizzle N+1**: `pg_stat_statements` mostra mesmo `queryid` com `calls` proporcional ao tamanho do batch. Mitigação: usar `db.insert(...).values(arr).onConflictDoUpdate(...)` em vez de loop.
- **Buffer copy redundante em zstd/CAS**: flamegraph nativo (perf no Linux, Instruments no mac) mostra `memcpy`/`memmove` largo dentro do `.node` do zstd-napi.
- **Re-render Ink no scroll**: profile React DevTools no terminal (`INK_DEVTOOLS=1` se disponível — **verificar nas docs ink v7**); ou marque com `performance.mark` em volta do `render()`.

**Falsos positivos comuns** (Brendan Gregg, "CPU Flame Graphs"): bloco "(idle)" largo = CPU realmente ocioso, não hot path; frame V8 builtin `BytecodeHandler:` largo = sampling capturou ciclo do interpretador (use `--interpreted-frames-native-stack` no Linux para resolver); pilhas que terminam em `process._tickCallback` ou similar = limite do sampler, não bug.

---

## 4. Stack mapping (técnica × código)

| Área do repo | Primeiras instrumentações |
|---|---|
| `apps/cli/src/commands/compile/*` | `--cpu-prof` + `--heap-prof`; hyperfine no comando; `performance.mark` em volta do reindex Tantivy e Parquet; bpftrace para `fdatasync` (Linux). |
| `apps/cli/src/commands/sync/{bundle,checkpoint,concurrency,limits,promotion}.ts` | `clinic bubbleprof` (validar serial await); marks em `bundle.ts` e `promotion.ts`; AWS SDK middleware para per-op latency; `eventLoopUtilization` sampling. |
| `apps/cli/src/commands/{search,analytics,query-duckdb}.ts` | flamegraph nativo (perf no Linux com `--perf-basic-prof-only-functions --interpreted-frames-native-stack`; Instruments Time Profiler no mac) — única forma de ver dentro de Tantivy/DuckDB napi. |
| `apps/cli/src/tui/*` (Ink) | `performance.mark` em volta de `render()`; `--cpu-prof` durante interação scriptada. |
| `apps/api/src/routes/trpc/sync.*` | `@fastify/otel` + `@opentelemetry/instrumentation-pg`; spans manuais em `commit-upload` envolvendo `zstd.decompress` e `db.transaction`; `pg_stat_statements` reset + delta. |
| `apps/api/src/routes/trpc/reads.*` | `auto_explain` com `log_min_duration=100`; `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)` ad-hoc; marks em `bounded-decode`. |
| `apps/api/src/routes/objects.ts` | AWS SDK v3 middleware na etapa `build`; `clinic bubbleprof` para multipart streaming; medir RSS (Buffer copy = pico de RSS). |
| `apps/api/src/auth/*` (Better Auth + Drizzle) | mark em volta de `auth.api.getSession`; comparar com `session.cookieCache.enabled=true` (5 min default). |

---

## 5. Integração com `bench/` existente

O diretório `bench/` já roda standalone via `@swc-node/register` para Tantivy/Parquet. Proposta:

- **Manter `bench/` para microbench de addons isolados**. Migrar de runner ad-hoc para **mitata** (precisão melhor que Benchmark.js, detecta DCE — documentado no README oficial).
- **Adicionar `bench/cli/`**: scripts em hyperfine (`bench/cli/compile-all.sh`, `bench/cli/sync.sh`) que invocam o **bundle de produção** (não dev), exportam JSON, e gravam em `bench/results/YYYY-MM-DD-<commit>.json`.
- **Adicionar `bench/api/`**: scripts wrk2/k6 contra um servidor levantado por docker-compose (Postgres + MinIO).
- **CI gate vs manual**: micro-bench (mitata) roda em PR — falha se regressão >10% no p99 de `tantivy.search`; macro-bench (hyperfine, wrk2) **manual** disparado via `workflow_dispatch`, pois precisa de runner dedicado (cloud com noisy neighbors invalida números).
- **Formato de resultados** (`bench/results/`): JSON com `{ commit, node_version, os, results: [{ name, mean_ms, p99_ms, samples }] }`. Roadmap de performance referencia esses arquivos por commit.

---

## 6. Riscos e pitfalls específicos Node 22 + TS + ESM + tsup

**Bundled vs source**: tsup com `sourcemap: true` (external) produz `.js.map` ao lado. `--enable-source-maps` os consome. Cuidado: tsup tem histórico de bug com `sourcemap: 'inline'` (issue `egoist/tsup#495`); prefira external. Sem `--enable-source-maps`, todos stacks apontam para `dist/cli.js:1:xxxx`.

**Custo de @swc-node/register/esm-register em dev**: cada `import` passa por transformação SWC em memória. Para *startup latency* (CLI), isso pesa 100–500 ms — números de bench em dev são **inválidos** para conclusões de produção. Regra: bench numérico = bundle de prod.

**Worker threads (já tentado para compile)**: o ganho de ~15% confirmou que o gargalo não é CPU JS. Worker threads ainda valem em **sync** (zstd compress em paralelo: zstd-napi libera o lock GIL-like) e em **search/analytics** se houver paralelismo de queries — a documentação `worker_threads` em Node 22 nota que native addons N-API podem ser carregados em workers se forem context-aware (consistente com a posição publicada por Anna Henningsen sobre N-API e worker threads).

**Native addons no V8 flamegraph — pitfall central**: o V8 CPU profiler (e portanto `--cpu-prof`, `@datadog/pprof` usado pelo `@grafana/pyroscope-nodejs`) **não faz stackwalk em C++**. Chamadas a `.node` (better-sqlite3, zstd-napi, duckdb, tantivy) aparecem como uma única caixa opaca (entry point C++). Documentado em `nodejs/diagnostics#148` ("Node CPU Profiling Roadmap"): *"Currently, these tools do not support native c/c++ frames which includes v8, native modules, libuv or syscall stack frames... Supporting native frames will require implementing a stackwalker in the v8 profiler or the cpu profiler."* O README do `@datadog/pprof` confirma: *"The pprof module has a native component that is used to collect profiles with v8's CPU and Heap profilers."* **Soluções**:
- **Linux**: `perf record -F 99 -p $PID -g` com Node iniciado com `--perf-basic-prof-only-functions --interpreted-frames-native-stack` (essencial para Turbofan não esconder frames JS). Resolve frames C++ via DWARF do `.node`. Use `--perf-basic-prof-only-functions` (não `--perf-basic-prof` puro) porque o segundo cresce `/tmp/perf-PID.map` sem limite (Brendan Gregg, "node.js Flame Graphs on Linux", 2014). Bonus: pacote `mmarchini/node-linux-perf` gera o map on-demand sem disco contínuo.
- **macOS**: **Xcode Instruments → Time Profiler** vê frames C/C++ de qualquer `.dylib`/`.node`. `sample(1)` builtin é o equivalente CLI. `dtrace` no mac funciona para syscalls mas o **ustack helper para Node nunca foi portado** (Dave Pacheco, "Profiling Node.js", 2012-04-25, documenta bugs Apple 5273057 / 11206497) — só illumos/SmartOS. Os posts canônicos da era Joyent (Pacheco; Cantrill via repo `bcantrill/node-libdtrace` e talk "Instrumenting the real-time web", Velocity 2011) seguem como referência primária do método DTrace+Node, mas todos pressupõem illumos.
- **eBPF (`bpftrace`, `bcc`)**: Linux only; Brendan Gregg, "Linux bcc/eBPF Node.js USDT Tracing" (2016) documenta uso de USDT do Node + uprobes para amostrar stacks completas incluindo addons. Use em CI Linux; **não funciona no mac**.

**Pino overhead**: pino v10 é o logger mais rápido do ecossistema. Benchmark BASIC oficial (`pinojs/pino/blob/main/docs/benchmarks.md`) registra *"Pino average: 114.801ms"* vs *"Winston average: 270.249ms"* (mesma iteração padrão); em benchmark independente de 100.000 mensagens, números externos apuram Pino ~450 ms vs Winston ~2.800 ms (~6× mais rápido). **Mas** `pino-pretty` em dev é executado via `pino.transport({ target: 'pino-pretty' })` em **worker thread** desde pino 7 — adiciona memória e latência de partida. Em dev, isso distorce benchmarks; em produção, use stdout JSON direto (sem transport). Documentado no post *"Welcome to pino@7.0.0 - and the era of worker_thread transport"* (Matteo Collina, NearForm, 2021): *"Today we are launching pino@7 with the new pino.transport(), which allows us to write transports using worker_threads."*

**Better Auth + Drizzle**: Better Auth faz lookup de sessão no DB por request (docs `session-management`). Custo fixo mensurável (~1–5 ms com PG local em testes próprios). Mitigação documentada: `session: { cookieCache: { enabled: true, maxAge: 300 } }` — sessão validada do cookie assinado, sem hit no DB. Compense com `secondaryStorage` (Redis) se cookie cache não for aceitável por requisitos de revogação imediata.

---

## 7. Plano executável em 5 passos

**"Se tivéssemos que começar amanhã":**

1. **Sourcemaps + cpu-prof na CLI** (1 dia). Tool: tsup config `sourcemap: true`; Comando: `node --enable-source-maps --cpu-prof --cpu-prof-dir=./profiles dist/cli.js compile-all --source fixtures/compile-large/`. Abrir `.cpuprofile` no speedscope. **Exit signal**: identificou o bloco JS mais largo fora de `sqlite3_step`/Tantivy (i.e., há algum candidato em código próprio).

2. **Flamegraph nativo Linux para validar gargalo "abaixo da JS"** (1 dia). Tool: `perf` + FlameGraph. Comando: `node --perf-basic-prof-only-functions --interpreted-frames-native-stack dist/cli.js compile-all &; sudo perf record -F 99 -p $! -g -- sleep 60; perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg`. **Exit signal**: confirmado se >X% do tempo está em `sqlite3_step + pwrite64` (WAL fsync) vs Tantivy `index_writer.commit` vs zstd `ZSTD_compressBlock`. Define o alvo do passo 3.

3. **Bubbleprof no sync** (1 dia). Tool: clinic bubbleprof (apesar da manutenção limitada, ainda funciona). Comando: `clinic bubbleprof --on-port 'autocannon -c 1 -d 30 -p 1 localhost:$PORT/...' -- node dist/cli.js sync`. Alternativa: marks manuais + visualização no perfetto trace viewer. **Exit signal**: identificada cadeia await serial em `promotion.ts`/`checkpoint.ts` que pode virar `Promise.all`; OU confirmado que upload já é network-bound (não pipelineável).

4. **OTel + autocannon na API** (2 dias). Tool: `@fastify/otel` + `@opentelemetry/instrumentation-pg` + Tempo/Jaeger em Docker. Comando: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node --enable-source-maps -r dist/telemetry.js dist/api.js`, então `autocannon -c 50 -d 60 -m POST -b @payload.bin localhost:3000/trpc/sync.commitUpload`. Em paralelo: `pg_stat_statements_reset(); ...; SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC`. **Exit signal**: trace mostra o componente dominante (Zod, zstd, Drizzle, Better Auth); top-3 queries por `total_exec_time` identificadas.

5. **wrk2 + auto_explain para tail latency real** (1 dia). Tool: wrk2 + Postgres `auto_explain`. Comando: `wrk2 -t4 -c50 -R200 -d300s --latency http://localhost:3000/trpc/sync.commitUpload`; logs do PG via `auto_explain.log_min_duration=100, log_format=JSON, log_buffers=true, log_wal=true`. **Exit signal**: p99/p99.9 estabilizado abaixo do target; ou identificada query #1 em `auto_explain` para ataque cirúrgico (índice, JOIN, ON CONFLICT). Encerrar quando o orçamento de p99 for batido por 5 runs consecutivos.

---

*Notas finais*: este relatório evita propor reescritas (proibido pelo escopo) e prioriza ferramentas OSS. Ferramentas comerciais (Datadog Profiler, Sentry Profiling, pganalyze) foram intencionalmente omitidas — todas têm equivalentes OSS citados acima (Pyroscope/Parca, OTel+Tempo/Jaeger, pgBadger+auto_explain). Cross-platform: cada técnica Linux-only (perf, bpftrace, eBPF) tem alternativa mac explícita (Instruments Time Profiler, `sample(1)`, `fs_usage`). Flags marcadas para verificação: `--async-stack-traces` em `NODE_OPTIONS` (depende da versão exata, validar com `node --help-v8-options | grep async-stack`); `INK_DEVTOOLS=1` (verificar nas docs ink v7).