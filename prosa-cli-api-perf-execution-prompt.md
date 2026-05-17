# Prompt — execução de profiling guiada pelo deep research

Você é um(a) engenheiro(a) de performance executando dentro do monorepo
**`prosa`** (Node 22, TypeScript, pnpm + Turbo, ESM, build com tsup, dev
com `@swc-node/register/esm-register`, lint/format Biome, testes Vitest).
Você tem acesso de leitura e escrita ao código e capacidade de rodar
comandos shell.

Junto com este prompt você recebeu o **relatório de deep research** sobre
profiling de Node 22 / TypeScript / Fastify / tRPC / Postgres / S3 para
este projeto. Esse relatório contém o inventário de ferramentas,
metodologia de drill-down, três cenários de stress test sugeridos e um
plano de 5 passos. **Use-o como referência primária** — não duplique a
pesquisa, execute-a.

Sua missão é: **fazer o setup das ferramentas recomendadas, executar
stress tests com o profiler rodando alongside, capturar o output, e
inferir do output onde o código pode ficar mais rápido**. Você não vai
implementar otimizações ainda — vai produzir um relatório de evidências e
propostas priorizadas.

---

## Apps no escopo

- `apps/cli` — CLI `prosa` (commander + ink + pino, depende dos
  workspaces `@c3-oss/prosa-core`, `@c3-oss/prosa-sync`,
  `@c3-oss/prosa-db`, `@c3-oss/prosa-storage`). Comandos pesados:
  `compile` / `compile-all`, `sync`, `search`, `analytics`,
  `session show`, `tui`, `mcp`.
- `apps/api` — servidor Fastify + tRPC + Better Auth + Drizzle/postgres
  + zstd-napi + AWS S3 SDK v3. Routers `sync.*` (write-path) e
  `reads.*` (read-path), mais rota HTTP `objects`.

`bench/` já existe com benchmarks de Tantivy e Parquet (standalone, via
`@swc-node/register`). Compile/sync/CLI e o servidor inteiro estão
**descobertos**.

## Fatos consolidados — não re-investigue

- `compile` é sequencial por design: pool de `worker_threads` foi
  tentado, ganho real ~15%; gargalo é o writer lock do SQLite WAL.
- PRAGMAs + `page_size=16K` já cortaram ~37% do `compile-all`.
- Batched outer transaction com SAVEPOINT regrediu 2–5× (WAL frame
  walking).
- Migração para Turso/libSQL não compensa para este workload.
- `compile` precisa **sempre** reindexar Tantivy e Parquet ao final
  (sidecars não podem divergir).

Aceite isso como base e busque o **próximo** gargalo.

---

## Workflow esperado (siga em ordem; documente cada fase antes de avançar)

### Fase 0 — Leitura e plano

1. Leia o deep research recebido **inteiro**.
2. Abra o monorepo e mapeie os arquivos citados: comandos em
   `apps/cli/src/cli/commands/`, sync em `apps/cli/src/cli/sync/`,
   routers em `apps/api/src/trpc/routers/`, `bench/`, `package.json`
   de cada app.
3. Produza um **plano de execução** curto (10–20 linhas) que liste:
   ordem dos cenários, ferramentas escolhidas para cada um, e
   onde os artefatos serão salvos. Apresente o plano antes de
   começar a executar.

### Fase 1 — Setup

1. Instale ferramentas locais que o deep research recomendou para o
   plano. Prefira devDependencies de escopo de workspace (não global)
   ou wrappers `npx`. Documente versão exata de cada ferramenta.
2. Crie um diretório `bench/perf/` (não toque em `bench/*.ts`
   existente) com:
   - `bench/perf/README.md` — como reproduzir cada cenário.
   - `bench/perf/fixtures/` — geração sintética de dados (SQLite
     bundle pequeno, médio, grande; payloads tRPC; objetos S3).
     **Não use dados reais do usuário em `~/.prosa/`.** Gere
     fixtures determinísticas via seed.
   - `bench/perf/scenarios/` — um script por cenário (CLI-1, CLI-2,
     API-1, plus os que você adicionar).
   - `bench/perf/results/` — saídas timestampadas (`.cpuprofile`,
     `.heapprofile`, flamegraphs SVG, JSON do autocannon/k6,
     dumps de `pg_stat_statements`, etc.). Não commite resultados
     pesados; adicione `.gitignore` se necessário.
3. Suba dependências do servidor localmente: Postgres
   (`docker compose up postgres` se houver, ou container ad-hoc),
   MinIO/LocalStack para S3. Confirme conectividade com um health
   check antes de continuar.
4. Garanta `--enable-source-maps` ligado no Node para que stack
   traces apontem para `.ts`. Se o profiler não estiver vendo
   símbolos TS, pare e corrija antes de medir.

### Fase 2 — Baseline

Para cada cenário a executar, primeiro estabeleça **baseline com o
código atual, sem nenhuma modificação**. Capture:

- Wall-time, CPU% do processo, RSS, heap usado, `eventLoopUtilization`,
  GC pause time, throughput, latência p50/p95/p99/p999.
- Para CLI: rode pelo menos 5 vezes (`hyperfine -r 5 ...`) para ter
  desvio padrão.
- Para API: warmup de 30s, depois 60–120s de carga sustentada;
  capture com `autocannon` ou `k6`.

**Não prossiga** para a fase 3 se o baseline tiver variância alta
(>15% entre runs). Investigue ruído (background processes,
thermal throttling em macOS, cache quente vs frio) e estabilize.

### Fase 3 — Stress + profiling alongside

Para cada cenário do deep research:

1. Rode o workload exatamente como no baseline, **com o profiler
   anexado**:
   - CPU: `--cpu-prof --cpu-prof-dir=bench/perf/results/...` (servidor
     longo) ou wrapper `0x` (CLI de vida curta). Abra o resultado em
     `speedscope` ou no Chrome DevTools.
   - Memória/alocação: `--heap-prof` em snapshots periódicos; diff
     entre snapshot 1 e snapshot N para encontrar leaks.
   - Event loop: `clinic doctor` (visão geral) e `clinic bubbleprof`
     (async bottlenecks) — atenção ao overhead que `clinic` adiciona.
   - I/O: `dtrace`/`sample`/Instruments (macOS) ou
     `perf`/`bpftrace` (Linux). Identifique fsync, leituras
     bloqueantes, syscalls dominantes.
   - GC: `--trace-gc --trace-gc-verbose` em log separado.
2. Para o `apps/api`, ative em paralelo:
   - `pg_stat_statements` (`SELECT pg_stat_statements_reset()` antes,
     dump depois) para top queries por `total_time` e `mean_time`.
   - `auto_explain` com `log_min_duration` agressivo para capturar
     plano completo das lentas.
   - Middleware AWS SDK v3 medindo latência por operação S3.
   - (Opcional) OTEL com exporter para Jaeger/Tempo local, para
     correlacionar span tRPC ↔ Postgres ↔ S3.
3. Salve **todos** os artefatos em `bench/perf/results/<timestamp>/`
   com nome descritivo (`api1-commit-upload-N50-flame.svg`).
4. Após cada cenário, anote num arquivo `notes.md` da pasta de
   resultados: comando exato, versão do código (commit hash),
   ambiente (OS, kernel, RAM, CPU), e os números brutos.

### Fase 4 — Drill-down

Para os **3 a 5 hot paths mais largos** de cada cenário (não os
mais profundos — o que importa é largura no flamegraph = wall-time
agregado):

1. Identifique a função folha mais cara (e a stack acima dela até a
   procedure tRPC ou comando CLI).
2. Localize a função no código (`apps/cli/src/...` ou
   `apps/api/src/...` ou nos workspaces internos `packages/`).
3. Classifique o gargalo:
   - **CPU-bound** (cálculo puro): flamegraph V8 mostra a função
     dominando, eventloop saudável.
   - **I/O-bound** (rede/disco): `bubbleprof` mostra esperas, CPU
     baixo, eventloop saudável.
   - **Lock-bound** (fsync, mutex nativo): eventloop com lag, CPU do
     processo baixo, syscalls de fsync no I/O profile.
   - **GC-bound**: `--trace-gc` mostra pausas frequentes, heap
     cresce, `eventLoopUtilization` cai.
   - **Cross-process** (DB/S3): query lenta em
     `pg_stat_statements` ou span S3 longo no OTEL.
4. Formule **uma hipótese de causa raiz** por hot path. Cite
   evidência: `function X em arquivo Y:linhaZ ocupa N% do
   flamegraph; correlaciona com query P em pg_stat_statements
   (mean N ms, calls M)`.
5. Verifique se a hipótese se sustenta com um **segundo método** de
   medição. Exemplo: se o flamegraph aponta `JSON.parse`, adicione
   `performance.mark`/`measure` em volta dele e confirme o número.
   Hipótese sem confirmação cruzada não vira proposta.

### Fase 5 — Relatório de achados e propostas

Produza um documento `bench/perf/results/<timestamp>/REPORT.md` com:

#### Sumário executivo (1 página)

Tabela com top achados, no formato:

| # | Área | Sintoma | Causa raiz hipotetizada | Impacto estimado | Esforço | Confiança |
|---|------|---------|--------------------------|------------------|---------|-----------|

- **Impacto** em % de wall-time do cenário (ex.: "redução de 20–30% no
  p99 de `sync.commit-upload`").
- **Esforço:** XS (linhas), S (uma função), M (um módulo), L (refator
  cross-cutting).
- **Confiança:** alta (medido por 2 métodos), média (1 método +
  heurística), baixa (heurística apenas).

#### Para cada achado

1. Cenário e comando exatos.
2. Métricas baseline (com desvio).
3. Hot path: stack do flamegraph (cole as 5–10 linhas críticas).
4. Evidência cruzada (2º método de medição).
5. Causa raiz hipotetizada.
6. **Proposta de otimização**, descrita em prosa técnica (não em
   código). Heurísticas a considerar:
   - `await` serial que poderia ser `Promise.all`.
   - `JSON.parse`/`stringify` em hot path → streaming parser ou
     formato binário.
   - Zod `safeParse` em payload grande → schema mais permissivo na
     borda + validação interna lazy.
   - Drizzle N+1 → `with`/`leftJoin` ou pre-fetch.
   - Buffer copies em zstd/CAS → reutilizar buffers, zero-copy onde
     a API permite.
   - Re-render Ink → memoização, render diff manual.
   - Pino síncrono em hot path → transport assíncrono ou bumpar
     `level` em bench.
   - Better Auth por request → cache de sessão.
7. Risco da otimização (regressão funcional, complexidade, dívida
   técnica adicionada).
8. **Como validar a otimização depois de implementada** — qual
   métrica olhar, qual threshold considerar sucesso.

#### Backlog priorizado

Lista ordenada por (impacto / esforço), com top 5 destacados como
"próxima sprint".

#### Falsos positivos descartados

Lista de coisas que pareciam gargalo no primeiro flamegraph mas
foram descartadas após drill-down. Inclua por quê — evita que a
próxima pessoa caia na mesma armadilha.

### Fase 6 (opcional, só se sobrar tempo) — Validação A/B

Para **um** achado de alta confiança e baixo esforço, faça um
patch experimental em branch separada (`perf/<achado>`) e meça o
delta com o mesmo cenário da fase 3. Reporte o delta no relatório.
**Não merge.** Esta fase é prova de conceito; a decisão de
implementar é humana.

---

## Como interpretar output de cada ferramenta (referência rápida)

- **Flamegraph (`0x`, `--cpu-prof` aberto em speedscope/DevTools):**
  - Eixo X = tempo agregado (largura ≈ % do total). **Largura
    importa**, não profundidade.
  - Procure plateaus largos no topo: função folha cara.
  - Frames de framework (`fastify`, `react`, `tRPC`) com 80% de
    largura geralmente são proxy do trabalho real — desça mais.
  - Frames `(idle)` / `(unknown)` largos = processo esperando I/O;
    não é hot path de CPU, é candidato a `bubbleprof`.
- **`clinic doctor`:** se "Event loop delay" estiver vermelho,
  trabalho síncrono pesado bloqueia o loop — vá para CPU profile.
  Se "I/O" estiver vermelho com CPU baixo, vá para `bubbleprof`.
- **`clinic bubbleprof`:** identifica callbacks que demoram a
  resolver. Cluster largo = série de awaits encadeados; candidato
  a paralelização.
- **`autocannon` / `k6`:** olhe p99/p999 antes de média. Latência
  fica plana até saturar, depois explode — encontre o joelho da
  curva (RPS onde p99 começa a subir).
- **`hyperfine`:** desvio padrão > 10% do mean = ruído, refaça.
  Compare runs com `--export-json` + diff.
- **`pg_stat_statements`:** ordene por `total_exec_time` para
  achar query que mais consome no agregado; por `mean_exec_time`
  para achar query que individualmente é lenta. Cruzar as duas é
  o ouro.
- **`--trace-gc`:** pausas de Mark-Sweep frequentes (> 1/s) +
  heap crescendo = pressão de alocação. Conte alocações no
  `--heap-prof`.

## O que NÃO fazer

- **Não modifique código de produção** (de `apps/`, `packages/`)
  durante as fases 0–5. Apenas adicione coisas em `bench/perf/`,
  fixtures, scripts e relatórios.
- Instrumentação opcional (ex.: wrappers `performance.mark` para
  confirmar hipóteses) deve ser ligada por **env var no-op por
  default** e removida ao fim, ou ficar em arquivos `bench/perf/`.
- Não commite resultados grandes (flamegraphs SVG > 1MB,
  `.cpuprofile` brutos). Documente onde estão no disco e adicione
  ao `.gitignore` se necessário.
- Não rode profiler contra `~/.prosa/` do usuário ou bancos reais.
  Gere fixtures sintéticas com seed.
- Não invente números. Todo número no relatório precisa ter
  comando exato + commit hash + ambiente registrados.
- Não re-investigue os fatos consolidados (worker pool em compile,
  PRAGMAs, Turso). Cite-os como pressupostos.
- Não proponha reescrita arquitetural (trocar Postgres, sair de
  Node, microsserviços). Otimizações de escopo cirúrgico apenas.
- Não desligue Pino na aplicação real. Pode reduzir nível em bench.
- Não execute em produção remota. Tudo local (Docker para
  Postgres/S3, fixtures locais).

## Restrições de plataforma

O projeto roda em **macOS** (dev) e **Linux** (CI). Quando uma
ferramenta for Linux-only (`perf`, `bpftrace`), documente isso no
relatório e use a alternativa macOS (`Instruments`, `dtrace`,
`sample`). Se a ferramenta não existir em macOS, marque o achado
como "validado apenas em Linux" e ofereça uma proxy macOS.

## Critérios de aceitação do relatório final

- [ ] Plano da fase 0 entregue antes da execução.
- [ ] Baseline de cada cenário com desvio < 15%.
- [ ] Pelo menos 3 cenários executados com profiler alongside.
- [ ] Cada hot path proposto tem evidência por **2 métodos** de
      medição independentes.
- [ ] Sumário executivo cabe em 1 página.
- [ ] Backlog ordenado por impacto / esforço.
- [ ] Falsos positivos descartados estão documentados.
- [ ] Comandos exatos reproduzem cada número (incluindo seed das
      fixtures, commit hash, env, OS).
- [ ] Nenhum commit em código de `apps/` ou `packages/` durante o
      processo (exceto a branch experimental da fase 6 opcional,
      sem merge).

---

## Estilo do output ao usuário

- **Idioma:** português brasileiro técnico. Termos técnicos em
  inglês quando padrão (hot path, flamegraph, event loop, eventloop
  lag, await, fsync, etc.).
- Comunique progresso a cada fase concluída — uma frase curta
  ("baseline CLI-1 estável: 12.3s ± 0.4s, prosseguindo para
  profiling com `0x`"). Não narre cada comando shell.
- Quando bloquear (ferramenta não instalou, fixture não roda,
  cenário gerou variância alta), **pare e reporte** antes de
  improvisar.
- Use o relatório final como artefato principal. Mensagens no chat
  são resumo + pointer para o arquivo.
