# Memo: lentidão do sync local grande

Data: 2026-05-16  
Contexto: sync local via `pnpm dev -- sync --keep-local --verbose` contra `~/.prosa`, API Docker local, Postgres e MinIO locais.

## Resumo

O sync estava lento principalmente porque o store local real é muito grande para o protocolo atual de promoção em batches pequenos. O dry-run estimou modo `chunked`, com cerca de 281 batches, a partir destes volumes:

- 3.141 sessões
- 291.498 `search_doc`
- 3.173 `source_files`
- 811.511 `raw_records`
- 834.333 objetos CAS
- 1.109.323 linhas de projeção estimadas

O CLI precisou dividir o envio por limites do servidor:

- `maxObjectsPerPlan`: 5.000 objetos por batch
- `maxRowsPerCommit`: 10.000 linhas por commit

Só a fase de CAS já implica aproximadamente 167 batches de objetos antes da fase de projeção. Como cada batch faz `planUpload` e `commitUpload`, há bastante overhead fixo mesmo quando poucos ou nenhum objeto precisa ser enviado.

## Causas observadas

1. O store excede muito os limites de batch único.

   O dry-run reportou explicitamente violações de limite para quantidade de objetos CAS e quantidade de linhas de projeção. O CLI entrou em modo `chunked`, estimando aproximadamente 281 batches.

2. A fase de objetos é muito fragmentada.

   Cada batch de CAS declara até 5.000 objetos. Quando faltam objetos, o CLI envia os bytes dos CAS objects antes de commitar o batch. Mesmo em Docker local, isso gera milhares de operações HTTP e escritas no MinIO.

3. O protocolo tem pelo menos duas round-trips estruturais por batch.

   Para cada batch há um `sync.planUpload` e um `sync.commitUpload`. Nos logs, batches com `missingObjects=0` ainda faziam commit:

   ```text
   plan object batch 1 ... declaredObjects=5000 missingObjects=0 rows=0
   commit object batch 1 • objects=0 rows=0
   ```

   Isso é correto para a semântica atual, mas adiciona custo fixo repetido.

4. Antes da correção de concorrência, uploads de objetos eram efetivamente sequenciais.

   Isso amplificava a latência por objeto. A correção posterior passou a fazer uploads concorrentes dentro de cada chunk, mas o design ainda continua limitado por muitas chamadas HTTP pequenas e muitos batches.

5. O servidor/API inicialmente tinha limites/configuração que mascaravam o gargalo real.

   Durante a investigação apareceram falhas antes de conseguir medir o sync de ponta a ponta:

   - `413 Request body too large` em `planUpload`, corrigido aumentando o `bodyLimit` do Fastify.
   - `getaddrinfo ENOTFOUND prosa.minio`, corrigido usando path-style no cliente S3/MinIO.
   - `Device is not authorized for this tenant/store`, causado por reuso do mesmo device em outro store e autorização acoplada ao `store_path`.

   Depois dessas correções, a lentidão restante passou a ser principalmente volume + granularidade do protocolo.

## Hipóteses prováveis

1. O tamanho de batch de CAS provavelmente é conservador demais para ambiente local.

   Com 834k objetos, `5.000` objetos por batch gera muitos ciclos plan/commit. Um tamanho maior, ou batches adaptativos, reduziria round-trips.

2. O protocolo é chatty para objetos pequenos.

   Se muitos CAS objects forem pequenos, o overhead HTTP por objeto pode dominar o tempo total. Um formato de upload empacotado, multipart em lote, ou endpoint bulk/streaming reduziria custo.

3. A retomada ainda é grosseira.

   A reexecução é idempotente, mas o CLI ainda revisita batches desde o começo. Isso é seguro, porém ruim para UX em stores grandes. Checkpoint local por fase/batch reduziria tempo após interrupções.

4. Batches sem objetos faltantes poderiam ter fast-path.

   O servidor já sabe no `planUpload` quando `missingObjects=0`. Dependendo das garantias desejadas, pode existir um caminho para evitar commit vazio de CAS-only batches ou consolidar essa confirmação.

## Impacto de UX

Para stores pequenos, o sync validado foi rápido e funcionou. Para `~/.prosa`, o dry-run e os primeiros batches mostram que o fluxo é operacional, mas a experiência ainda parece longa demais para uso interativo porque o usuário vê centenas de batches antes de qualquer dado de projeção estar totalmente aplicado.

Além disso, a fase inicial imprime muitos commits com `objects=0 rows=0`, o que parece progresso vazio e reduz confiança, mesmo quando tecnicamente está validando/avançando o estado de batch.

## Recomendações

1. Adicionar medição explícita por fase.

   Mostrar tempo por `plan`, upload CAS, `commit`, objetos enviados por segundo, linhas por segundo e ETA por fase.

2. Implementar checkpoint/resume por batch.

   Persistir último batch CAS/projeção concluído localmente, mantendo idempotência no servidor.

3. Avaliar batch size adaptativo.

   Aumentar `maxObjectsPerPlan` para ambiente local ou ajustar dinamicamente por tamanho total do payload, não apenas contagem de objetos.

4. Considerar upload bulk de CAS.

   Reduzir uma chamada HTTP por objeto quando houver muitos objetos pequenos.

5. Melhorar mensagens de progresso.

   Separar claramente `verifying existing objects`, `uploading missing objects` e `promoting projection rows`, para evitar a sensação de commits vazios.
