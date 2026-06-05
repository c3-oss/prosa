# prosa — code review (master @ 114f89a)

> Date: 2026-06-05  
> Branch: `master` at `114f89a8e7e5107cc215e1560b38b0065975d233`  
> Total: 8 reports, ~25.800 palavras  
> Reviewers: 8 subagentes em paralelo, cada um focado em uma dimensão

Cada relatório segue o mesmo formato (Sumário → Achados ranqueados por
severidade → "What I checked" → Recomendações) com citações `file:line`
em todos os achados.

## Reports

| Arquivo | Foco | Achado headline |
|---|---|---|
| [`go-idioms.md`](go-idioms.md) | Idioms Go, error handling, contexto, deps, lint hygiene | `slog.SetDefault` mutation global durante `sync` (`internal/cli/sync.go:480`); `err == sql.ErrNoRows` em vez de `errors.Is` em 2 sites |
| [`security.md`](security.md) | Análise adversária — input, auth, secrets, file ops, templates | Path traversal no preserve-raw de 5 importers via session ID controlado por atacante; falta de validação de formato de `session.Id` no server; CSRF ausente nas rotas POST do panel |
| [`importers.md`](importers.md) | 6 importers: consistência, duplicação, edge cases | Apenas hermes `inMemSink` implementa `SkipCache` — o mesmo gap que mascarou o bug de FK em `114f89a` continua nos outros 5; ~200 linhas duplicadas extraíveis para `importerutil/` |
| [`store.md`](store.md) | SQLite + Postgres + migrations + projection + FTS5 | Posture sólida (split `sync_state`/`import_skips` correto, `ProjectionVersion` "exemplar"); pontos finos: alinhamento de `ON DELETE` em `sessions.device_id`, return signature de `LastHash` |
| [`cli.md`](cli.md) | Comandos, flags, render TTY/pipe, UX | Flag `--no-color` declarada e não implementada (deletar ou implementar); 4 switches de scope-detection de 15 linhas espalhados (extrair helper); 3 implementações distintas de duration formatting |
| [`panel-server.md`](panel-server.md) | Connect handlers + panel HTML + HTMX + OAuth | Analytics bifurcado entre SQLite e Postgres com shapes divergentes (heatmap conta colunas diferentes); falta CSRF; falta cache headers em assets estáticos; SSE proxy sem `ResponseHeaderTimeout` |
| [`testing.md`](testing.md) | Estratégia, cobertura, qualidade dos testes | **Critical**: o padrão do fake que escondeu o bug de FK em hermes existe nos 5 outros importers; migration up/down identity tests ausentes; sem fuzz targets nos parsers; `time.Now()` não injetável |
| [`architecture.md`](architecture.md) | Boundaries `internal/pkg`, layering, responsabilidades cruzadas | **Sem criticals** — boundaries respeitadas; `internal/cli/sync.go` virou orquestrador de 701 linhas fazendo 5 trabalhos distintos; analytics forked é a maior fonte real de drift |

## Cross-cutting headlines

Achados que aparecem em múltiplos relatórios — alta prioridade:

### 1. Fakes de teste mascarando contrato de produção

Mesmo padrão que produziu o bug de FK em `114f89a`. O `inMemSink` em
`hermes/importer_test.go` agora implementa `SkipCache`; **os outros 5
importers não**, e os testes "passam" sem exercitar idempotência real.

Cobertura: [`testing.md` F1](testing.md), [`importers.md` F2](importers.md).

### 2. Validação de identificadores controlados por atacante

Session IDs vêm de bytes externos (JSONL do agente, SQLite do hermes) e
fluem para:
- `filepath.Join(rawRoot, sessionID+ext)` — escapa em `../../etc/...`.
- S3 object keys no server.
- `data: <id>\n\n` no SSE do panel.

Cobertura: [`security.md` findings 1-3](security.md).

### 3. Analytics duplicado entre store local e server

`internal/store/analytics.go` (SQLite) e `internal/server/handlers/analytics.go`
(Postgres) reimplementam os mesmos 5 relatórios com SQL diferente,
cabeçalhos diferentes, shapes de linha diferentes. O CLI passa por uma
camada de normalização (`normalizeRemoteAnalyticsResult`) que esconde
drift visível (e.g. heatmap com contagem de colunas divergente).

Cobertura: [`architecture.md`](architecture.md) high #2, [`panel-server.md`](panel-server.md) M4-5.

### 4. CSRF + security headers ausentes no panel

POSTs do panel (`/cli/authorize/approve`, `/dev-login`, `/devices/*`,
`/logout`) protegidos apenas por `SameSite=Lax`. Nenhuma rota emite
CSP/X-Frame-Options/nosniff.

Cobertura: [`security.md`](security.md) finding 4-5, [`panel-server.md`](panel-server.md) #7.

### 5. `internal/cli/sync.go` — 701 linhas, 5 responsabilidades

Orquestração + renderização + identity backfill + state machine + wiring
de comando no mesmo arquivo. Onde o próximo bug "esquecemos de
atualizar Y junto com X" vai aparecer.

Cobertura: [`architecture.md`](architecture.md) high #1, [`cli.md`](cli.md) M2/L1.

## Top-10 ações por ROI

Ranking cross-cutting baseado em todos os relatórios (custo baixo,
impacto significativo, sem violar INTENT):

1. **Adicionar `validateSessionID()` em `pkg/session`** e usar no server
   `Push` + em cada `preserveRaw` dos importers. Fecha 3 high de
   `security.md` numa só mudança.
2. **Promover `inMemSink` a um helper compartilhado em
   `internal/importers/importertest/`** e implementar `SkipCache` em
   todos. Garante que o bug-class de `114f89a` não se repete. ([`testing.md` F1](testing.md), [`importers.md` F2](importers.md))
3. **CSRF middleware no panel** (10 linhas). Fecha [`security.md`#4](security.md).
4. **Trocar `err == sql.ErrNoRows` por `errors.Is`** em
   `internal/server/handlers/auth.go:110` e
   `internal/importers/cursor/parse.go:96`. Patch trivial. ([`go-idioms.md`](go-idioms.md))
5. **Unificar analytics** atrás de um único `AnalyticsRow` proto + dois
   dialect helpers (sqlite + postgres). Elimina
   `normalizeRemoteAnalyticsResult`. ([`architecture.md`](architecture.md))
6. **Quebrar `internal/cli/sync.go`** em `sync.go` (orquestração) +
   `sync_summary.go` (render) + `sync_identity.go` (backfill).
   ([`architecture.md`](architecture.md), [`cli.md`](cli.md))
7. **Extrair `internal/importers/importerutil/`** com `hashAndSize`,
   `preserveRaw`, `parseTimestamp`, `openReadOnly`, scanner buffer
   constants. ~200 linhas a menos. ([`importers.md` F3](importers.md))
8. **Security headers middleware** (CSP, X-Frame-Options, nosniff).
   ([`security.md`#5](security.md))
9. **`connect.WithReadMaxBytes(64 << 20)` + `ReadHeaderTimeout`** —
   limita DoS por payload gigante e slowloris. ([`security.md`#8](security.md))
10. **Pipe paths user-facing através de `internal/paths`**:
    `login.go` e `sync_push.go` hardcodam `~/.config/prosa/auth.json`
    em mensagens visíveis ao usuário, mesmo já importando o pacote.
    ([`architecture.md`](architecture.md))

## O que está saudável

Para calibração — coisas que vários revisores destacaram como bem
construídas:

- **Boundaries arquiteturais** respeitadas: `pkg/` não importa
  `internal/`; panel não importa store; server não importa importers
  ([`architecture.md`](architecture.md)).
- **Idiom Go** em geral forte: 260 `fmt.Errorf("...: %w", ...)`, zero
  `//nolint`, `log/slog` em toda parte não-CLI, vet limpo
  ([`go-idioms.md`](go-idioms.md)).
- **SQL parametrizado** em todo lugar; FTS5 bound; PKCE/state/sha256;
  `html/template` + goldmark com unsafe desligado
  ([`security.md`](security.md)).
- **Disciplina de `ProjectionVersion`** v6→v7→v8 elogiada como
  exemplar; split `sync_state` (real ids) vs `import_skips` (real ou
  sintético) é o shape certo ([`store.md`](store.md)).
- **Generated code** sob `gen/` é limpo; nenhum código hand-written
  shadowa types do proto ([`architecture.md`](architecture.md)).
- **Migration ownership clean**: CLI escreve SQLite, server escreve
  Postgres, nada cruza ([`store.md`](store.md), [`architecture.md`](architecture.md)).

## Calibração dos relatórios

Cada relatório foi escrito por um agente independente sem visibilidade
do trabalho dos outros. Quando dois ou mais relatórios convergem
sobre o mesmo achado (CSRF, analytics fork, fake inMemSink, sync.go
inchado, path traversal), o sinal é forte. Achados isolados a um
relatório merecem segunda checagem antes de virar trabalho.

Limites do que essa revisão **não cobriu** explicitamente:

- Performance/benchmarks (nenhum revisor mediu nada).
- Auditoria completa de CVEs em deps (sugerido rodar `govulncheck`).
- Comportamento de releases (GoReleaser snapshot, npm publish shim) — só revisado superficialmente.
- Documentação (`docs/`) — fora do escopo dos 8 reviewers; o
  `prosa-docs-reviewer` especialista existe e seria o próximo passo.
