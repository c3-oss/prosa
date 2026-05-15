# Prosa Ralph Loop Retrospective

## Executive Summary

O Ralph loop teve sucesso parcial alto, mas não sucesso autônomo de qualidade
final.

Claude/Ralph entregou uma quantidade grande de implementação: monorepo, API
HTTP/tRPC, autenticação, tenancy, sync, object storage, CLI auth/sync, leituras
remotas iniciais, Docker/E2E e uma base útil de testes. Isso validou o modelo
como mecanismo de throughput.

O processo só chegou a um estado defensável porque houve uma camada externa de
arquitetura, revisão e intervenção. Codex monitorou o loop, fez steering via
`docs/roadmap/server-sync/ralph-loop-prompt.md`, executou revisão adversarial
com subagentes, corrigiu falhas críticas e depois conduziu uma rodada de
refatoração/qualidade antes de abrir o PR.

O veredito atualizado é:

- Ralph/Claude foi bom para produzir fundação funcional rapidamente.
- Steering via arquivo de prompt funcionou, mas foi assíncrono e não
  determinístico.
- Subagentes em paralelo foram essenciais para descobrir problemas reais em
  segurança, integridade e legibilidade.
- O processo precisa de phase gates formais para que "Done" signifique
  shippable.

## O Que Funcionou

### Throughput De Implementação

O loop conseguiu construir uma fatia grande do produto em pouco tempo:

- `apps/api` com Fastify/tRPC;
- Better Auth com tenant/organization;
- sync one-way de bundle local para servidor;
- object store memory/fs/S3;
- CLI `auth` e `sync`;
- leituras remotas para sessões/search/analytics iniciais;
- E2E com Postgres/S3/CLI;
- monorepo pnpm/Turbo.

Esse é o tipo de trabalho em que um executor long-running agrega valor real:
muita cola, scaffolding, testes iniciais e integração entre pacotes.

### Steering Via Prompt

O arquivo `docs/roadmap/server-sync/ralph-loop-prompt.md` serviu como canal de
feedback. Depois que Codex acrescentou uma correction queue, o loop reiniciado
produziu commits corrigindo pontos que tinham sido explicitamente listados.

Funcionou para correções concretas:

- tenant authorization;
- device auth;
- config fail-fast;
- upload de CAS;
- `verifyPromotion` mais rigoroso;
- E2E Docker;
- schema drift em sync.

Não funcionou como mecanismo de governança:

- não havia ACK explícito de que Ralph leu cada item;
- não havia status por correção;
- não havia evidência por lane;
- alguns itens foram resolvidos parcialmente;
- Ralph declarou Done antes de invariantes críticos estarem fechados.

Conclusão: prompt-file steering é útil como backlog assíncrono, mas não deve
ser o gate final.

### Subagentes Paralelos

A rodada posterior com subagentes foi decisiva. Ela separou o problema em
domínios independentes:

- promoção/manifests/transações;
- CAS/object route;
- leituras remote-authoritative;
- auth/device/tenant abuse;
- refatoração da API sync;
- refatoração da CLI sync;
- refatoração de auth/reads/rate-limit.

Esse modelo aumentou cobertura sem bloquear o caminho crítico. Os subagentes
não apenas revisaram: validaram se os achados eram reais, aplicaram patches de
escopo restrito e reportaram comandos executados e riscos residuais.

## Principais Falhas Encontradas Depois Do Done

### Promoção Não Era Atômica O Suficiente

Antes das correções finais, `commitUpload` podia persistir projeções e objetos
em etapas que não estavam protegidas por uma transação clara. Uma falha no meio
do fluxo podia deixar estado parcial.

Correção aplicada:

- API ganhou `transaction` no database handle;
- commit/verify/cleanup passaram a operar com status de batch controlado;
- testes cobrem rollback e replay.

### Manifesto Era Muito Dependente Do Cliente

O cliente conseguia declarar conjuntos em verify que não eram necessariamente
iguais ao plano original.

Correção aplicada:

- `sync_batch_object_manifest`;
- `sync_batch_projection_manifest`;
- commit rejeita drift entre plan e commit;
- verify compara declarações contra manifesto server-owned;
- receipt ganhou `manifestHash` e contadores por tipo.

### Object Route Podia Aceitar Upload Fora Do Protocolo

Um usuário autenticado podia fazer PUT de objeto sem vínculo forte a um batch
aberto. Também havia risco de escrever bytes no object store antes de detectar
conflito no catálogo.

Correção aplicada:

- PUT exige `batchId`;
- PUT exige manifesto de objeto em batch aberto do tenant/usuário;
- metadata de upload precisa bater com o manifesto planejado;
- conflito em `remote_object` é verificado antes de escrever bytes;
- testes cobrem upload órfão, conflito de catálogo, hash de transporte,
  hash canônica, zstd e limite de descompressão.

Risco residual:

- o PUT ainda não é transacional entre object store e banco. Se o insert em
  `remote_object` falhar depois do `putIfAbsent`, pode sobrar byte órfão.
  Isso pede garbage collection/reconciliação ou uma área de staging.

### CAS Canônico Não Estava Provado

O servidor precisava provar duas identidades:

- hash de transporte dos bytes enviados;
- hash canônica dos bytes originais/descomprimidos.

Correção aplicada:

- `objectId` deve ser `blake3:<hash>`;
- hashes precisam ser BLAKE3 hex de 64 chars;
- zstd é descomprimido com limite;
- hash canônica é recalculada no servidor.

### Leituras Remotas Vazavam Estado Não Verificado

Depois de commit, mas antes de verify, dados podiam ficar legíveis pelas rotas
remotas.

Correção aplicada:

- `sessions`, `search` e `analytics` filtram por manifests vinculados a
  batches `verified`;
- testes multi-device verificam que dados committed/unverified não aparecem.

### CLI Ainda Misturava Autoridade Local E Remota

O requisito de produto diz que depois de login + sync a store remota vira
autoridade. A CLI ainda tinha superfícies que abriam o bundle local
silenciosamente.

Correção aplicada:

- `resolveReadAuthorityOrFailClosed`;
- comandos com suporte remoto usam servidor;
- comandos sem paridade remota falham fechado por padrão;
- `--local` existe como override explícito e deixa claro o risco de stale data.

### Sync CLI Era Difícil De Auditar

O comando `sync` concentrava leitura de bundle, preflight, upload de CAS,
commit, verify, persistência de promoção, cleanup e output no mesmo arquivo.

Correção aplicada:

- `apps/cli/src/cli/sync/bundle.ts`;
- `apps/cli/src/cli/sync/limits.ts`;
- `apps/cli/src/cli/sync/promotion.ts`;
- `apps/cli/src/cli/commands/sync.ts` virou orquestração.

Esse foi um ganho importante de manutenção. O código ficou mais revisável e
os riscos de mexer em sync diminuíram.

## Resultado Do Steering

Codex conseguiu fazer steering do Claude/Ralph, mas com baixa previsibilidade.

Evidências positivas:

- o loop reiniciado respondeu a itens adicionados ao prompt;
- commits posteriores atacaram a correction queue;
- alguns problemas específicos foram claramente derivados do steering.

Limitações observadas:

- não havia protocolo de confirmação por item;
- não havia "done-check" automatizado;
- o mesmo arquivo acumulava contexto, instruções e correções;
- correções com invariantes complexos foram implementadas parcialmente.

Recomendação:

- manter `ralph-loop-prompt.md` como canal humano-legível;
- adicionar `correction-queue.md` com IDs, status, owner e acceptance criteria;
- adicionar `evidence/lane-N.md` obrigatório por lane;
- bloquear Done se qualquer correction blocking estiver aberta;
- exigir comandos e logs por lane.

## Rodada Pós-Loop: Adversarial Review

Depois da primeira finalização, Codex fez uma análise adversarial e escreveu
lanes de hardening em:

```text
docs/roadmap/server-sync/adversarial-hardening/
```

Essas lanes foram úteis porque converteram achados difusos em fases de
correção:

- transactional promotion;
- server-owned manifests;
- CAS/object store hardening;
- schema constraints/migrations;
- chunked sync/large bundles;
- remote-authoritative reads;
- auth/device/tenant abuse;
- adversarial test gates.

Em seguida, subagentes validaram e corrigiram partes dessas lanes. Esse fluxo
foi superior ao review monolítico: cada agente teve ownership claro e pôde
rodar testes focados.

## Rodada Pós-Loop: Qualidade E Refatoração

Uma segunda rodada com subagentes focou qualidade do código:

- `apps/api/src/trpc/routers/sync.ts` foi dividido em handlers menores;
- `apps/api/src/http/objects.ts` foi reestruturado em helpers claros;
- `apps/api/src/trpc/routers/auth.ts` e `reads.ts` tiveram rate-limit,
  filtros e mapeamentos extraídos;
- `apps/cli/src/cli/commands/sync.ts` foi dividido em módulos de sync.

Findings relevantes dessa etapa:

- complexidade pós-hardening cresceu rápido e precisava ser reduzida antes de
  virar base permanente;
- arquivos grandes escondiam invariantes de segurança em fluxos longos;
- subagentes de refatoração funcionaram melhor quando receberam ownership por
  arquivo/diretório;
- lint/typecheck e testes focados foram suficientes para integrar as mudanças
  sem regressão aparente.

## Validação Executada Na Rodada Final

Antes do PR, foram executados:

```text
pnpm typecheck
pnpm lint
```

Também foram executadas suítes focadas durante a integração:

- API object upload hardening;
- API sync;
- API sync manifest;
- API sync transaction;
- API verify promotion;
- API auth/authz/rate-limit;
- API multi-device reads;
- CLI sync promotion;
- CLI sync CAS;
- CLI remote authority;
- CLI auth token lifecycle;
- CLI analytics isolado.

Observação:

- `analytics.test.ts` falhou por timeout quando rodado junto com testes E2E de
  sync em paralelo, mas passou isolado. Isso foi tratado como contenção de
  suíte, não como regressão funcional.

## Commits E PR

A branch do PR é:

```text
codex/server-sync-hardening-refactor
```

O PR aberto é:

```text
https://github.com/c3-oss/prosa/pull/12
```

Os commits foram separados por tema:

- docs do hardening;
- build root com Turbo;
- foundation transacional/protocolo/schema;
- manifests server-owned no sync;
- hardening de object upload;
- auth/rate-limit/roles;
- remote-authoritative reads;
- auth token lifecycle;
- refatoração da CLI sync.

Essa separação tornou o review mais viável do que um commit único, mas ainda
há um ponto de melhoria: quando mudanças são desenvolvidas em loops longos, a
disciplina de commits precisa existir desde o início. Fazer a separação no fim
é possível, mas mais caro.

## Recomendações Para O Próximo Processo Misto

### 1. Definir Gates Antes Do Kickoff

Cada lane deve ter:

- owner;
- invariantes;
- acceptance criteria;
- comandos obrigatórios;
- evidência esperada;
- riscos explicitamente aceitos.

### 2. Separar Prompt, Status E Corrections

Arquivos recomendados:

```text
docs/roadmap/<feature>/
  ralph-loop-prompt.md
  status.md
  correction-queue.md
  evidence/
    lane-01.md
    lane-02.md
  gates.md
```

### 3. Tornar Done Uma Operação Verificável

Ralph não deve declarar Done apenas por terminar tarefas ou estabilizar o
worktree. Done deveria exigir:

- correction queue blocking zerada;
- evidence manifests preenchidos;
- testes obrigatórios passados;
- E2E Docker quando aplicável;
- revisão adversarial concluída;
- aprovação explícita do gatekeeper.

### 4. Usar Subagentes Com Ownership Disjunto

Subagentes foram mais eficazes quando receberam limites claros:

- arquivos/diretórios sob responsabilidade;
- objetivos verificáveis;
- comandos esperados;
- proibição de reverter mudanças alheias.

Isso deve virar padrão para revisões grandes.

### 5. Registrar Intervenções Do Arquiteto

Quando Codex precisa corrigir diretamente, isso deve ser marcado como:

```text
Architect intervention
```

Motivo:

- separa "Ralph delivered" de "Codex repaired";
- evita falsa confiança no executor;
- melhora o desenho de prompts/skills/subagentes futuros.

## Skills/Subagents Que Valem Ser Criados

### `ralph-loop-governor`

Responsável por:

- executar ciclos idle/check/document;
- detectar estagnação;
- atualizar monitor;
- abrir correction queue;
- decidir quando acionar subagentes.

### `server-sync-security-reviewer`

Responsável por:

- CAS/hash/canonical identity;
- tenant isolation;
- auth/device abuse;
- cleanup destructive safety;
- batch/status state machine.

### `remote-authoritative-read-reviewer`

Responsável por:

- garantir que cada CLI read surface respeita autoridade remota;
- verificar fail-closed;
- comparar paridade local/remota;
- propor rotas remotas faltantes.

### `e2e-gate-runner`

Responsável por:

- subir Docker;
- rodar E2E;
- consultar DB com `psql`;
- validar object store;
- registrar evidência reproduzível.

### `refactor-integrator`

Responsável por:

- procurar arquivos longos;
- dividir módulos sem mudar comportamento;
- reduzir handlers complexos;
- rodar typecheck/lint/testes focados;
- preservar ownership de outros agentes.

## Artefatos Materializados

O fluxo foi convertido em artefatos versionados para a próxima execução:

- `.codex/skills/ralph-loop-governor/`: skill para Codex preparar lanes,
  prompt, correction queue, monitoramento, subagentes e gate final.
- `.codex/skills/ralph-loop-governor/assets/`: templates de prompt,
  status, correction queue, gates e evidência por lane.
- `.codex/agents/ralph-loop-*.toml`: subagentes para segurança, integridade
  de promoção, leituras remotas, E2E Docker e refatoração pós-hardening.
- `docs/roadmap/server-sync/ralph-loop-operating-model.md`: playbook de uso,
  incluindo os prompts exatos para iniciar e reiniciar o Ralph Loop.

## Veredito Final Atualizado

O experimento valeu a pena.

Mas a conclusão correta não é "Ralph consegue fazer tudo sozinho". A conclusão
é que Ralph/Claude é um ótimo motor de execução quando existe uma camada forte
de arquitetura, steering, subagent review e gates.

O processo futuro deve ser desenhado assumindo isso:

- Ralph executa;
- Codex governa;
- subagentes auditam;
- gates automatizados decidem se pode avançar;
- intervenções arquiteturais ficam registradas.

Nesse formato, o modelo misto tem potencial para ser reproduzível. Sem esses
controles, ele produz software impressionante, mas com aparência de completude
maior do que a completude real.
