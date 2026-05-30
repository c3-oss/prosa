# Prosa V3 — INTENT

Documento de *steering* para a reescrita em Go. Define **o que o produto é, o que faz parte do MVP, e como as peças se encaixam**. Regras curtas; sem narrativa. Contexto histórico no apêndice.

---

## 1. Objetivo

Responder rapidamente **"no que eu trabalhei nos últimos N dias?"** consolidando sessões de agentes de IA (Claude Code, Codex, e outros via plugin) em um histórico unificado, consultável de duas formas:

- **CLI local** (offline-first) — store deste device.
- **Painel web** (cross-device) — visão unificada de todas as máquinas.

A pergunta-raiz manda no design. Qualquer decisão que não a sirva é candidata a corte.

---

## 2. Princípios

1. **Enxuto > completo.** Sem DuckDB, sem Parquet, sem CAS sofisticado. SQLite local + Postgres no server.
2. **Single-user.** Sem multi-tenancy no schema. Server é pessoal.
3. **Push-only.** Cliente empurra; server armazena. Sem replicação bidirecional (foi onde a V2 inflou).
4. **Idempotente por hash.** Cada upload é no-op se o hash já existe no server. Re-syncs são baratos.
5. **Camadas no store.** Metadata + FTS no DB; raw em arquivos separados. Disco controlado.
6. **Offline-first no CLI.** Por padrão, lê o store local. `--remote` consulta o server.
7. **3 binários Go.** CLI, server, panel — independentes; CLI e panel são clientes da API do server.
8. **Plugin de importer.** Interface tipada Go (`pkg/importer`). MVP cobre Claude Code + Codex.
9. **Confiança no próprio server.** Sem redaction antes do upload no MVP (TLS no transporte).

---

## 3. Escopo

### Dentro do MVP

- 3 binários Go: `prosa` (CLI), `prosa-server`, `prosa-panel`.
- Importers de Claude Code e Codex, ambos implementando a interface plugin.
- Store local: SQLite + arquivos raw `.jsonl` (1 por sessão, sharded).
- Server: Postgres + S3-compatível (R2/B2/MinIO).
- Auth single-user via `prosa login` (browser).
- Sync push-only, full upload por hash, idempotente.
- Sync híbrido: agendado (LaunchAgent/cron a cada N min) + `prosa sync` manual.
- Timeline cronológica (1 linha = 1 sessão).
- Filtros estruturados (`--last`, `--project`, `--device`, `--agent`) + busca textual FTS5.
- Auto-filtro pelo cwd quando dentro de projeto conhecido (`--all` derruba).
- Drill-down: `prosa show <id>` imprime raw.
- Analytics fixos: `sessions`, `tools`, `errors`, `models`, `projects`.
- Painel web (templ + HTMX) como primeira tela do dia.

### Fora do MVP

- MCP server (pode entrar depois — alto valor "meta").
- TUI interativa residente (painel cobre). _Não confundir com a animação de feedback no CLI via Bubble Tea — ver §8._
- Export (CSV/Parquet/JSON).
- Multi-user / multi-tenant.
- Redaction de secrets antes do upload.
- Pull on-demand de sessões de outros devices pro store local.
- Retention/prune automático.
- Cold-tier de storage no server.
- Upload incremental por byte-range ou por turno.

---

## 4. Arquitetura

### Componentes

| Binário | Função | Stack |
|---|---|---|
| `prosa` (CLI) | Importa, lê store local, sincroniza, consulta. | Go + Connect client |
| `prosa-server` | API tipada, persistência, autenticação. | Go + Connect handler + pgx + S3 SDK |
| `prosa-panel` | Web SSR; consome a API do server. | Go + Connect client + templ + HTMX |

CLI e panel são **clientes** do server. Não há comunicação direta CLI ↔ panel.

### API tipada — Connect-Go (Buf)

- Contratos em `proto/prosa/v1/*.proto` (source-of-truth).
- Geração Go em `gen/go/prosa/v1/` via `buf generate` (CI valida no PR).
- Server expõe handlers Connect; aceita JSON e binário (proto). Browser fala JSON.
- CLI e painel usam clients gerados; sem código de serialização manual.
- Schemas versionados em `v1`, `v2`, etc. — breaking changes só com bump de versão.

### Store local (cliente)

- SQLite em `~/.local/share/prosa/store.db` (XDG; override por `PROSA_HOME`).
  - Metadata por sessão (timestamps, projeto, device, agente, modelo, tools usadas, hash, etc.).
  - FTS5 sobre turnos (`role`, `content`).
  - Tabela `sync_state(session_id, last_hash, last_synced_at)`.
- Raw em `~/.local/share/prosa/raw/<agent>/<YYYY>/<MM>/<session-id>.jsonl`.
  - **1 arquivo por sessão**, sharded por agente/ano/mês para evitar diretórios gigantes.
  - Nunca listado por filesystem; sempre acessado via lookup no DB.

### Server

- **Postgres**: `devices`, `sessions`, `turns` (com FTS nativo), `tools`, opcional `tokens`/métricas.
- **S3-compatível**: objetos raw em `s3://<bucket>/<device-id>/<agent>/<YYYY>/<MM>/<session-id>.jsonl`.
- Migrations gerenciadas em `migrations/server/`.

### Sync (push-only)

Para cada sessão detectada/modificada localmente:

1. Cliente computa `hash = sha256(raw)`.
2. Se `hash == sync_state.last_hash`, no-op.
3. Caso contrário, `POST /sessions/<id>` com raw no body + header `X-Prosa-Hash`.
4. Server armazena raw no S3, atualiza Postgres (substitui a versão anterior; turnos antigos estão dentro do raw novo por natureza append-only).
5. Cliente atualiza `sync_state.last_hash`.

Não há diff, não há byte-range, não há replicação de volta.

### Lifecycle de sessão

- **Scan**: cada `prosa sync` varre os diretórios dos agentes registrados (`~/.claude/projects`, `~/.codex/sessions`, etc.).
- **Detecção de mudança**: `sha256` do arquivo `.jsonl` comparado com `sync_state.last_hash`. Diferente → reprocessa.
- **Sessão ativa**: `last_activity` (timestamp do último turno parseado) a menos de **10 minutos** do "agora". Limite fixo no MVP.
  - Sync sobe normalmente (full upload por hash) mesmo com sessão viva. Sem debounce.
  - Painel exibe badge `live`; CLI marca a linha com asterisco/cor.
- **Sessão fechada**: `last_activity >= 10 min`. Sem badge, semântica de upload idêntica.
- **Raw órfão**: se o agente apaga/rotaciona o `.jsonl` original, prosa mantém o raw que preservou. Sem auto-delete. Limpeza explícita via `prosa prune` fica fora do MVP — política definida quando houver dor real de disco.

---

## 5. Detecção de projeto

Ordem de tentativa para cada sessão:

1. **`git remote get-url origin`** no cwd da sessão → URL canônica vira identidade do projeto. Estável cross-device.
2. **Marker file `.prosa.yaml`** no cwd ou em ancestrais → campo `project: <name>`.
3. **Cwd como fallback** → sessão marcada como `unscoped` (visível, mas separada de projetos reais).

Sessões do mesmo `git remote` em devices diferentes são o **mesmo projeto**.

---

## 6. Identidade

- **User**: single-user. Schema sem coluna `user_id`.
- **Device**: fingerprint estável = `hash(hostname + machine-id)`.
  - Linux: `/etc/machine-id`.
  - macOS: `IOPlatformUUID`.
  - Windows: `MachineGuid` no registro.
  - `friendly_name` derivado de `hostname`, editável via `prosa devices rename`.

### Auth do CLI (device)

- `prosa login` abre browser → server emite token único por device → token em `~/.config/prosa/auth.json`.
- Bearer no header de toda chamada Connect a partir do CLI.
- Revogável via `prosa devices revoke <name>` (no painel ou outro device logado).

### Auth do painel (browser)

- OAuth via provider externo (GitHub e/ou Google).
- Server valida `email` contra whitelist do owner (`hi@caian.org`); qualquer outro email → 403.
- Sessão = cookie HttpOnly, Secure, SameSite=Lax, TTL 30d.
- Sem necessidade de senha, sem envio de email no MVP.

---

## 7. Fluxos

### `prosa login`

1. Coleta fingerprint do device.
2. Abre browser apontando pra `prosa.c3.do` (configurável) com device-code.
3. Usuário aprova no painel; server emite token e registra device.
4. Token salvo localmente.
5. Instala LaunchAgent/cron (ou systemd user timer no Linux) para sync periódico.

### `prosa sync`

1. Scan dos diretórios de cada agente registrado (`~/.claude/projects`, `~/.codex/sessions`, etc.) via importers.
2. Para cada arquivo `.jsonl`: computa `sha256(raw)`. Se igual ao último hash visto, no-op. Caso contrário, parse → atualiza/insere metadata + FTS no store local; preserva o raw em `~/.local/share/prosa/raw/...`.
3. Para cada sessão com `hash != sync_state.last_hash`: upload via API.
4. Atualiza `sync_state`.

Rodável ad-hoc; também disparado pelo agendador a cada N min (default sugerido: 15 min, configurável).

### `prosa` (nu)

1. Detecta projeto do cwd.
2. Query store local: últimos 7 dias (default), filtrado por projeto se aplicável.
3. Imprime timeline: hora, duração, projeto, device, agente, primeira pergunta, tools principais.

### `prosa show <session-id>`

Imprime o raw da sessão (paginado/`less`). `--json` mantém estrutura; default é leitura humana.

### `prosa search <query>`

FTS5 sobre turnos no store local. `--remote` faz a mesma busca via API do server (cross-device).

### `prosa analytics <report>`

Reports fixos: `sessions | tools | errors | models | projects`. SQL puro sobre SQLite (local) ou Postgres (`--remote`). Sem dependência de DuckDB/Parquet.

### `prosa devices`

Lista devices conhecidos (somente útil em modo remoto). Subcomandos: `rename`, `revoke`.

---

## 8. CLI — convenções

- **Comando nu** (`prosa`) abre timeline default (últimos 7d).
- **Dentro de projeto conhecido**, auto-filtra; `--all` derruba o filtro.
- **Filtros como flags**: `--last 30d`, `--since 2026-01-01`, `--between A..B`, `--project foo`, `--device laptop`, `--agent claude-code|codex`.
- **Fonte**: `--remote` consulta server; sem flag = store local.
- **Output**: padrão é tabela formatada; `--json` para scripting.

### Layout da timeline (default)

```
Today
  11:24  laptop   claude  prosa       "refactor sync logic"
         ⤷ 32min  edit, bash
  09:02* laptop   codex   mz-iac      "setup terraform module"
         ⤷ 18min  write, grep
Yesterday
  23:55  laptop   claude  prosa       "intent doc"
         ⤷ 1h12   edit, write, bash
```

- **Headers de dia** em escala relativa: `Today / Yesterday / N days ago` até 7 dias; nome do dia da semana de 7 a 30 dias; data absoluta (`May 02`) acima de 30 dias.
- **Linha principal**: hora `HH:MM`, marcador de ativa (`*`), device, agente, projeto, primeira pergunta do usuário (entre aspas, truncada por `…` se exceder).
- **Sublinha** (`⤷`): duração da sessão (`32min`, `1h12`) + até 3 tools mais usadas, separadas por vírgula.
- **Cores em TTY**: cinza (hora/duração), ciano (device), amarelo (agente), verde (projeto), padrão (primeira pergunta), vermelho (asterisco de ativa).
- **Sem TTY** (pipe/redirect/script): plain text sem cores nem cabeçalho de dia repetido.
- **Truncamento por elipse** (`…`) quando largura da coluna excede.

### Rendering & feedback

- **Lipgloss** é a engine de estilo do CLI: cores, larguras, truncamento responsivo, headers de dia, badges, alinhamento. Plain text sem cores fora de TTY (pipes/scripts).
- **Bubble Tea** entra apenas como **engine de animação progressiva**, estilo `docker compose up` — spinners, linhas de status atualizando in-place, progress bars, tickbox de fases. Usada em comandos longos:
  - `prosa sync` — progresso do scan por agente; spinner por sessão sendo importada/upload.
  - `prosa login` / `prosa setup` — wizard passo a passo com tickbox.
  - `prosa search` — resultados streaming conforme chegam.
- **Sem TUI residente.** `prosa` nu (timeline) e demais comandos de leitura renderizam uma vez e saem. Não há app interativo `j/k`/drill-down inline — interatividade fica no painel web.

---

## 9. Painel — UX

- **Estilo**: denso, Linear-like. Sidebar fixa à esquerda + main area. Teclado-first (`j/k` navegam, `/` busca, `esc` fecha drawer/panel).
- **Auth**: OAuth GitHub/Google; whitelist owner (`hi@caian.org`). Cookie de sessão 30d.
- **Views do MVP**:
  - **Home** (`/`) — timeline cronológica cross-device. Filtros via chips no topo (período, projeto, device, agente). Busca FTS na sidebar ou via `/`. Drill-down de sessão abre **side panel direito** (URL ganha `?session=<id>`); mostra metadata + raw paginado. `Esc` fecha.
  - **Devices** (`/devices`) — lista de máquinas com `last_sync`, total de sessões, status (ativo/idle). Ações: rename, revoke token.
  - **Analytics** (`/analytics/<report>`) — 5 reports fixos como subroutes: `sessions | tools | errors | models | projects`. Tabular denso, somente leitura.
- **Sem view dedicada pra Projects**: projeto é dimensão de filtro na Home e aparece no report `analytics/projects`.
- **Atualização**: SSE no painel pra notificar "nova sessão chegou" (badge/contador no header). Sem WebSocket completo no MVP.

---

## 10. Onboarding e distribuição

### Primeira execução

`prosa setup` é o ponto de entrada interativo numa máquina nova. Wizard com passos:

1. Server URL (default sugerido; configurável).
2. Autenticação via browser (OAuth GitHub/Google).
3. Detecção automática dos agentes instalados (paths típicos: `~/.claude/projects`, `~/.codex/sessions`, etc.).
4. Configuração do agendador (LaunchAgent no macOS, systemd user timer no Linux); intervalo default **15 min**, configurável.
5. Primeiro scan (opt-in com progresso visual; pode ser pulado e rodado depois com `prosa sync`).

`prosa login` é sub-fluxo do setup; pode ser invocado isoladamente para re-autenticação ou em máquinas já configuradas.

### Distribuição do binário

- **Homebrew tap** (`brew install c3-oss/prosa/prosa`) — fonte primária no macOS; publicado via `homebrew_casks` em cada release.
- **install.sh** (`curl -fsSL https://raw.githubusercontent.com/c3-oss/prosa/master/install.sh | sh`) — instala em `~/.local/bin` ou `/usr/local/bin`; fetch da release mais recente no GH com verificação sha256.
- **npm** (`npm install -g @c3-oss/prosa`) — mantém continuidade com a base de usuários V2. Pattern esbuild/biome com `optionalDependencies` por plataforma; zero `postinstall` download.
- **GitHub releases** — tarballs por OS/arch como source-of-truth. Brew tap, install.sh e npm apontam pra cá.
- Plataformas-alvo no MVP: **macOS (arm64, amd64)** e **Linux (amd64, arm64)**. Windows fica para depois.
- `prosa-server` e `prosa-panel` distribuídos no mesmo release; deploy é tarefa do owner (self-hosted ou PaaS).

---

## 11. Estrutura do repositório

```
prosa/
├── cmd/
│   ├── prosa/             # CLI binary
│   ├── prosa-server/      # API server binary
│   └── prosa-panel/       # Web panel binary
├── proto/
│   └── prosa/v1/          # Contratos Connect (.proto)
├── gen/
│   └── go/prosa/v1/       # Buf-gen output (commitado)
├── pkg/                   # Exportável (terceiros podem importar)
│   ├── importer/          # Interface plugin de importer
│   └── session/           # Tipos de domínio (não-API)
├── internal/              # Privado ao módulo
│   ├── store/             # SQLite local
│   ├── sync/              # Lógica de push-only
│   ├── server/            # Postgres + S3 + handlers Connect
│   ├── panel/             # Templ templates + handlers
│   └── importers/         # Implementações concretas: claudecode, codex
├── migrations/
│   ├── local/             # SQLite (golang-migrate ou embed)
│   └── server/            # Postgres
├── buf.yaml
├── buf.gen.yaml
├── go.mod
└── README.md
```

Um único `go.mod`. `go build ./cmd/...` produz os 3 binários. `buf generate` regenera stubs antes do build.

---

## Apêndice — Comentários do Autor

O Prosa nasceu de um problema bastante concreto: eu queria conseguir responder, com facilidade, uma pergunta simples na aparência, mas difícil na prática: no que eu trabalhei nos últimos N dias?

Hoje, o meu trabalho é praticamente todo focado em agentes de IA. Uso bastante o Claude Code e o Codex, e, olhando para as sessões desses agentes, consigo reconstruir boa parte do que fiz em uma determinada semana. O problema é que essas informações ficam espalhadas, presas a ferramentas diferentes, em formatos diferentes, e nem sempre são fáceis de consultar depois.

A primeira versão do Prosa surgiu justamente para resolver isso: criar uma forma rápida, unificada e 100% local/offline de revisitar essas sessões. A ideia inicial era simples: indexar localmente o histórico dos agentes e permitir que eu consultasse esse material com mais facilidade. Essa versão funcionou relativamente bem para o objetivo inicial, embora tivesse um problema importante: ela gerava muitos arquivos no store.

A segunda versão nasceu de uma percepção nova: eu não trabalho mais apenas em uma única máquina. Hoje, posso trabalhar no meu computador principal, em uma máquina remota, em um servidor de trabalho ou em qualquer outro ambiente. Isso significa que existem sessões de diferentes agentes espalhadas por diferentes computadores.

A partir daí, veio a ideia de ter um servidor central. O Prosa local poderia se autenticar nesse servidor remoto e fazer uma espécie de sincronização: pegar as sessões disponíveis na máquina local e enviá-las para esse servidor. Com isso, eu passaria a ter um painel web com uma visão unificada de todas as minhas máquinas, de todas as sessões registradas, de onde cada sessão foi executada, de quais projetos elas pertencem e de quanto está sendo consumido em tokens. Em vez de uma visão fragmentada, eu teria uma visão completa do meu trabalho com agentes.

A V2, no entanto, sendo bem honesto, foi praticamente 100% vibe coded. Ela nunca funcionou tão bem quanto deveria. Não houve, da minha parte, um trabalho cuidadoso de arquitetura antes da implementação, então algumas decisões foram sendo tomadas no caminho e simplesmente carregadas adiante.

O resultado é que hoje existe uma V2 funcional, mas extremamente lenta. Ela não trabalha de forma cumulativa: toda vez que uma sincronização acontece, o histórico é praticamente duplicado. Isso é péssimo para armazenamento, para desempenho e para a confiabilidade do sistema. Além disso, ela ocupa muito espaço em disco, consome memória demais para funcionar e, olhando agora, parece ter acumulado um certo bloat de funcionalidade.

Parte disso veio do próprio processo de arquitetura. Na época, eu perguntei à IA quais tecnologias poderiam ser usadas, e acabaram surgindo sugestões como Parquet e DuckDB. São ferramentas interessantes, mas hoje me parece que elas extrapolaram a finalidade real do sistema. O Prosa não precisava necessariamente nascer como uma infraestrutura analítica pesada. Ele precisava, antes de tudo, resolver bem o problema central: coletar, organizar, sincronizar e permitir a consulta eficiente das sessões dos agentes que eu uso no dia a dia.
