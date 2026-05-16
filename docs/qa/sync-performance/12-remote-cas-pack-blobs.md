# 12 — Remote CAS pack blobs para reduzir cardinalidade no S3

**Tier**: 2-3 (mudanca de protocolo e schema) · **Onde**: servidor,
storage, cliente · **Impacto estimado**: alto para buckets com muitos objetos
pequenos · **Esforco**: L

## Fact-check 2026-05-16

**Veredicto**: o problema existe, e #07 nao resolve essa parte. O endpoint
`POST /objects:bulk` reduz a quantidade de requests HTTP cliente -> API, mas,
se continuar chamando `putIfAbsent` por entrada, o servidor ainda cria um
objeto S3 por CAS object.

Estado atual confirmado no codigo:

- `objectStorageKey` gera `objects/blake3/<aa>/<bb>/<hash>.zst|.bin` para cada
  hash CAS.
- `S3ObjectStore.putIfAbsent` executa um `PutObjectCommand` para a key recebida.
- `remote_object.storage_key` e unica, entao o schema atual assume uma key
  fisica diferente por `object_id`.
- `RemoteObjectStore.get/head/putIfAbsent/delete` opera em objetos inteiros; nao
  ha primitiva de range read nem tabela de localizacao por offset.
- `GET /objects/:objectId` e `artifacts.getText` resolvem `storage_key` e leem o
  objeto inteiro diretamente.

Referencias externas checadas:

- S3 tem namespace plano; "pastas" sao prefixes de key, nao diretorios reais.
  Isso confirma que o fanout nao cria diretorios no S3, mas continua criando
  milhoes de objetos. <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html>
- S3 escala com requests paralelos e prefixes, com pelo menos milhares de
  requests por segundo por prefixo. Portanto, packing nao e necessario por
  limite bruto de throughput do S3; o argumento e reduzir cardinalidade,
  requests, catalogo e custo operacional. <https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html>
- S3 `GetObject` suporta `Range`, mas nao multiplos ranges em um unico `GET`.
  Um objeto CAS lido de dentro de um pack ainda custa um `GET` de range por
  leitura individual. <https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html>
- Multipart upload e util para packs grandes: partes de 5 MiB a 5 GiB, com
  ultima parte menor permitida, e ate 10 000 partes por upload.
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html>

## Mudanca proposta

Separar identidade logica CAS de localizacao fisica no object store.

O `object_id` continua sendo `blake3:<hash>` dos bytes canonicos originais. A
manifest, `tenant_object`, projection rows e dedupe global continuam falando em
CAS objects. O que muda e que varios CAS objects pequenos podem apontar para um
mesmo blob fisico no S3.

Modelo fisico novo:

```sql
CREATE TABLE remote_blob (
  blob_id text PRIMARY KEY,
  storage_key text NOT NULL UNIQUE,
  storage_kind text NOT NULL, -- 'inline' | 'pack'
  format text NOT NULL,       -- 'raw-object' | 'prosa-pack-v1'
  size_bytes bigint NOT NULL,
  object_count integer NOT NULL,
  pack_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE remote_object_location (
  object_id text PRIMARY KEY REFERENCES remote_object(object_id) ON DELETE RESTRICT,
  blob_id text NOT NULL REFERENCES remote_blob(blob_id) ON DELETE RESTRICT,
  offset_bytes bigint NOT NULL,
  length_bytes bigint NOT NULL,
  ordinal integer NOT NULL,
  transport_hash text NOT NULL
);
```

`remote_object` permanece como catalogo logico. Para compatibilidade, os objetos
atuais podem ser tratados como `inline`: uma linha `remote_blob` por objeto, ou
um resolver legado que usa `remote_object.storage_key` quando nao ha
`remote_object_location`.

## Pack format

Usar um envelope sem compressao global. Cada membro ja carrega os bytes de
transporte atuais (`.zst` ou `.bin`) e continua verificavel isoladamente por
`transport_hash`.

Key fisica sugerida:

```text
packs/blake3/<aa>/<bb>/<packHash>.ppack
```

Formato conceitual:

```text
MAGIC "PRPK"
VERSION 1
HEADER_LEN
HEADER JSON:
  {
    entries: [
      {
        objectId,
        hash,
        transportHash,
        compression,
        uncompressedSize,
        compressedSize,
        offset,
        length
      }
    ]
  }
BYTES concatenados na ordem das entries
TRAILER packHash
```

O pack hash deve cobrir header canonico + bytes concatenados. O servidor valida
cada entrada antes de publicar o catalogo:

- `objectId === blake3:<hash>`.
- `transportHash` bate com os bytes armazenados no pack.
- Quando `compression=zstd`, o payload descomprime para `uncompressedSize` e o
  hash canonico bate com `hash`.
- A entrada foi declarada por batch aberto do tenant atual.
- Nao ha duplicata de `objectId` no pack.
- Catalogo existente, se houver, e metadata-identico.

## Fluxo de upload

1. `planUpload` continua retornando `missingObjectIds`.
2. Cliente agrupa apenas objetos missing e pequenos em packs. Objetos grandes
   continuam no PUT individual.
3. Cliente chama `POST /object-packs?batchId=...`.
4. Servidor valida todas as entries, escreve um unico blob S3, e so depois
   insere `remote_blob`, `remote_object` e `remote_object_location` em transacao.
5. Se a transacao falhar depois do PUT, o servidor remove o pack blob em
   best-effort, igual ao cleanup atual de objeto individual.

Caps iniciais conservadores:

- Pack alvo: 64-128 MiB.
- Max pack: 256 MiB, ou negociado no handshake.
- Max entries por pack: 10 000.
- Pack somente para objetos abaixo de 256 KiB ou 1 MiB ate haver benchmark.

## Fluxo de leitura

O resolver de objeto deixa de retornar apenas `storage_key` e passa a retornar
uma localizacao:

```ts
type ObjectLocation =
  | { kind: 'inline'; storageKey: string; length: number }
  | { kind: 'pack'; storageKey: string; offset: number; length: number }
```

Para `inline`, o caminho atual permanece. Para `pack`, o storage adapter precisa
ganhar uma primitiva:

```ts
getRange(key: string, offset: number, length: number): Promise<ReadableStream<Uint8Array>>
```

No S3 isso vira `GetObjectCommand({ Range: "bytes=start-end" })`. Em FS/memory,
slice/stream local. O handler segue devolvendo exatamente os bytes comprimidos
do objeto CAS, com os mesmos headers atuais.

## Impacto esperado

Exemplo: 1 000 000 CAS objects pequenos, media de 8 KiB comprimidos.

| Estrategia atual | Objetos S3 | PUTs S3 | Observacao |
| --- | ---: | ---: | --- |
| Um CAS por key | 1 000 000 | 1 000 000 | Modelo atual |
| Bulk HTTP #07, mas explode no servidor | 1 000 000 | 1 000 000 | Reduz API/TLS, nao S3 |
| Pack 64 MiB | ~125 | ~125 | Reduz cardinalidade fisica em ~8000x |
| Pack 128 MiB | ~63 | ~63 | Melhor cardinalidade, maior blast radius |

O ganho real depende do perfil:

- Melhor caso: muitos objetos pequenos, sync inicial, leitura posterior pouco
  frequente ou em amostras.
- Pior caso: workload que le objetos individuais aleatoriamente o tempo todo;
  cada leitura ainda faz um `GET Range`, e S3 nao atende varios ranges no mesmo
  `GET`.

## Riscos e armadilhas

- **Schema atual bloqueia sharing fisico**: `remote_object.storage_key UNIQUE`
  nao permite varios objects apontarem para a mesma key. Precisa tabela de
  localizacao ou relaxar o contrato.
- **Metadata S3 por objeto some**: metadata por CAS deve ficar em Postgres, nao
  em headers S3 individuais.
- **Blast radius maior**: um pack corrompido afeta muitos CAS objects. Mitigar
  com `pack_hash`, verificacao por range em samples e `remote_object_location`.
- **GC mais complexo**: nao da para deletar fisicamente um membro isolado. Packs
  sao imutaveis; deletar so quando nenhum `remote_object_location` aponta para
  o blob, ou aceitar tombstones ate compactacao.
- **Read amplification parcial**: ler um objeto pequeno exige `GET Range` no
  pack. Continua melhor que baixar o pack inteiro, mas nao junta varios objetos
  numa unica request.
- **Compactacao retroativa e perigosa**: migrar objetos S3 ja existentes para
  packs deve ser job separado, com prova de hash antes de trocar locations e
  sem apagar inline ate leitura/verificacao passar.

## Plano de implementacao recomendado

1. Adicionar `remote_blob` e `remote_object_location`, mantendo fallback para
   `remote_object.storage_key`.
2. Estender `RemoteObjectStore` com `getRange`; implementar S3, FS e memory.
3. Mudar resolvers de leitura para passarem por `ObjectLocation`.
4. Criar `POST /object-packs` para gravar packs novos, mas manter
   `PUT /objects/:objectId`.
5. Alterar cliente para packar apenas objetos pequenos retornados como missing.
6. Adaptar `findMissingObjectIds`, `commitUpload` e `verifyPromotion` para
   verificarem catalogo/logical location sem `HEAD` por membro. No maximo, HEAD
   por pack blob.
7. Depois de estabilizar, criar compactor opcional para objetos inline antigos.

## Ordem com as outras propostas

Nao implementar como primeira otimizacao. Antes:

- #01/#11: bulkificar `planUpload` e `findMissingObjectIds`.
- #02: bulk projection/catalog upserts.
- #04/#11: tirar loops seriais de `commitUpload`/`verifyPromotion`.
- #10: medir por fase e separar tempo de API, DB, object store e upload bytes.

Depois disso, se o problema dominante for cardinalidade/custo do bucket, pack
blobs sao a solucao estrutural. Se o gargalo for so latencia HTTP cliente -> API,
#07 e suficiente e muito menos invasivo.

## Como validar

- Teste de contrato: um objeto inline e um objeto packed retornam bytes e
  headers identicos em `GET /objects/:objectId`.
- Teste multi-tenant: tenant sem grant nao consegue ler membro packed.
- Teste de integridade: pack com membro truncado, offset errado, hash errado ou
  duplicate objectId e rejeitado.
- Teste de retry: reenviar pack identico nao duplica catalogo; reenviar com
  metadata divergente falha.
- Teste de GC: pack com membro referenciado nao e apagado; pack sem referencias
  pode ser removido.
- Benchmark: 100k e 1M objetos pequenos contra MinIO/S3, comparando contagem de
  objetos fisicos, PUTs, wall-clock, custo estimado de requests e latencia de
  leitura por objeto.
