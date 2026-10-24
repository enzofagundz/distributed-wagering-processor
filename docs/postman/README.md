# Contratos HTTP no Postman

Material para executar e avaliar a API atual, sem instalar dependências ou publicar coleções. Visão geral e preparação da aplicação: [README](../../README.md). Decisões e limites: [ARCHITECTURE](../../ARCHITECTURE.md).

## Importação

1. Prepare banco, migrations e aplicação conforme o README; espere a API estar pronta.
2. Em Import no Postman, importe [wallets.postman_collection.json](wallets.postman_collection.json) e [local.postman_environment.json](local.postman_environment.json).
3. Selecione o environment Wallet HTTP — Local. `baseUrl` começa em `http://127.0.0.1:3000`, sem barra final; ajuste para a porta publicada localmente, se necessário.
4. Para smoke em uma API, execute as pastas 1 a 4 em ordem, com uma iteração no Collection Runner. Scripts ficam em Pre-request e Post-response; resultados aparecem em Test Results. A pasta 5 usa três APIs e tem roteiro manual próprio abaixo.

O pre-request da coleção pede token `client_credentials` ao Keycloak local (`tokenUrl`, `clientId`, `clientSecret` no environment) e o reaproveita até 30 s antes de expirar. Os requests usam `provider-a`, igual à claim `providerId` do token; outro provider no body recebe 403 `PROVIDER_IDENTITY_MISMATCH`. O secret do environment é local. Use ambiente local descartável: cada envio de abertura válida cria dados persistentes; a coleção não limpa o banco e não existe endpoint HTTP de exclusão.

## Sequência de smoke

| Ordem / requests | Resultado esperado |
| --- | --- |
| 01 — Abrir carteira positiva | 201; gera `playerId` UUID novo, abre com `9007199254740993.01 BRL` e captura `walletId`. |
| 02 — Consultar carteira positiva | 200; mesma identidade, dinheiro exato e versão 1. |
| 03 — Repetir abertura — duplicata 409 | 409 `WALLET_ALREADY_EXISTS`; reutiliza o mesmo `playerId` e BRL, sem gerar UUID novo. |
| 04 — Consultar carteira após duplicata | 200; saldo e versão não mudaram. |
| 05 — Consultar ledger positivo | 200; exatamente um CREDIT, saldo anterior `0.00`, saldo posterior igual à abertura, `nextCursor: null`. |
| 06 — Abrir carteira zero | 201; usa `zeroPlayerId` e `zeroWalletId`, preservando as variáveis do cenário positivo. |
| 07 — Consultar carteira zero | 200; saldo `0.00 BRL`, versão 1. |
| 08 — Consultar ledger vazio | 200; `{ "items": [], "nextCursor": null }`. |
| 09–19 — Erros do contrato | 400, 404 ou 409 conforme o cenário, com código exato verificado pelos scripts. |

Requests 01 a 19 cobrem abertura, ledger e erros. Os requests 18 e 19 dependem de 01; 02 a 05 também. Os requests 07 e 08 dependem de 06. Para repetir somente a duplicata, reenvie 03: 01 sempre cria outro jogador e outra wallet.

A pasta 4 é independente das anteriores: execute 20 a 29 em ordem. Request 20 cria wallet de `100.00 BRL` e gera novas chaves e identidades externas; não o repita para testar replay. Requests 21 e 22 processam BET de `80.00` e repetem seu resultado; 23 e 24 rejeitam outra BET de `80.00` e repetem a rejeição. Request 25 verifica payload divergente com a mesma chave: 409 `IDEMPOTENCY_CONFLICT`. Requests 26 e 27 consultam sucesso por ID interno e rejeição por provider/ID externo; ambos retornam 200. Requests 28 e 29 conferem reconciliação e único débito.

As variáveis `bet*` e `race*` são preenchidas pelos scripts no environment selecionado, separadas das wallets originais. Não crie variáveis homônimas nos dados de iteração. Respostas originais são guardadas para comparar identidade, status, saldo e código de falha no replay.

Os scripts verificam contratos HTTP e efeitos visíveis no ledger. Não inspecionam tabelas internas nem comprovam rollback ou publicação de eventos. Exemplos salvos nos requests antigos são ilustrativos; requests novos não apresentam capturas inventadas.

## Disputa visual entre três instâncias

A pasta 5 usa `instance1Url`, `instance2Url` e `instance3Url`, com valores iniciais `http://127.0.0.1:3101`, `http://127.0.0.1:3102` e `http://127.0.0.1:3103`. `baseUrl` continua independente, para o smoke em uma API.

Prepare o `.env` na raiz conforme o [setup no host](../../README.md#host). O roteiro usa `DATABASE_URL` de desenvolvimento; os testes automatizados usam `TEST_DATABASE_URL`.

```sh
test -f .env || cp .env.example .env
docker compose up -d --wait postgres
bun run migration:up
```

Abra três terminais na raiz do projeto e rode um dos comandos abaixo em cada um. Bun lê o mesmo `.env`; apenas a porta muda:

```sh
PORT=3101 bun run start
PORT=3102 bun run start
PORT=3103 bun run start
```

Aguarde `Wallet HTTP listening` nos três terminais. Se usar Podman, substitua `docker compose` por `podman compose`.

1. No Postman, execute 30. Ele abre wallet de `100.00 BRL` e preenche `raceWalletId`, jogador, chaves e IDs externos.
2. No DBeaver ou pgAdmin, conecte ao banco indicado por `DATABASE_URL` no `.env`. O exemplo usa `wagering` em `127.0.0.1:55432`, com usuário e senha locais `wagering`. Abra uma sessão SQL e execute o bloco abaixo com o UUID de `raceWalletId`. Deixe a transação aberta.

```sql
BEGIN;
SELECT id FROM wallets WHERE id = 'UUID_DE_RACE_WALLET_ID' FOR UPDATE;
```

3. Abra 31 e 32 em abas separadas. Clique Send nas duas antes de liberar o lock. São apostas diferentes de `80.00`, enviadas às instâncias 1 e 2; ambas devem ficar esperando.
4. Na mesma sessão SQL, execute `ROLLBACK;`. A transação de controle não mudou saldo; apenas segurou a linha. Uma aposta deve retornar 201/PROCESSED e outra 422/REJECTED com `INSUFFICIENT_FUNDS`. Qual vence pode variar. Não abandone a sessão com transação aberta.
5. Execute 33 e 34. A instância 3 deve reproduzir cada resultado, com `idempotentReplay: true`, mesma transação e saldo `20.00`.
6. Execute 35 e 36. Reconciliação deve retornar saldo armazenado e calculado `20.00 BRL`, diferença zero, `consistent: true` e dois lançamentos. Ledger deve conter um CREDIT de abertura e um único DEBIT de `80.00`.

No Runner, a pasta 5 também pode conferir esses resultados em sequência, mas isso não demonstra simultaneidade. Para repetir a disputa, comece em 30: uma wallet já debitada não representa novamente o cenário inicial.

Para observar wallets independentes, mantenha uma wallet bloqueada em sessão SQL e envie sua BET. Antes de liberar o lock, crie outra wallet com jogador novo e envie uma BET válida para ela por outra instância. A segunda deve concluir enquanto a primeira espera. Não execute 30 nesse intervalo: ele substituiria as variáveis da disputa em andamento.

A prova automatizada inclui 50 envios concorrentes, barreira de locks em três processos e progresso entre wallets:

```sh
bun test tests/integration/wallet-concurrency.test.ts
```

A collection não dispara um lote de 50 envios concorrentes. O teste acima inicia seus próprios processos e confere o ledger. Hot wallet continua serializada; esse roteiro não mede throughput. Evidências executadas ficam em [verificação](../verification.md).

## Formatos e respostas

- `POST /wallets` recebe `{ "playerId": "<UUID>", "initialBalance": { "amount": "1.00", "currency": "BRL" } }` e retorna 201 com `{ "id": "<UUID>", "playerId": "<UUID>", "balance": { "amount": "1.00", "currency": "BRL" }, "version": 1 }`.
- `GET /wallets/:walletId` retorna 200 com o mesmo formato de carteira. Não há datas ou transação na resposta da carteira.
- `GET /wallets/:walletId/ledger` retorna 200 com `items` e `nextCursor`. Cada item contém `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter` e `createdAt`. Os três valores monetários são objetos `{ "amount": "...", "currency": "BRL" }`; `createdAt` é uma string de data/hora.

`amount` é sempre string decimal não negativa com exatamente duas casas, sem notação exponencial nem zeros à esquerda além de `0.00`. Não converta dinheiro para `Number`; o valor positivo do smoke exercita precisão acima de `Number.MAX_SAFE_INTEGER`. A moeda deve pertencer a `Intl.supportedValuesOf('currency')`; `BRL` é válido, `brl` não. `playerId` e IDs de carteira precisam seguir o formato UUID. A unicidade da abertura é por jogador e moeda.

Abertura positiva persiste carteira, uma transação `OPENING` processada, um lançamento `CREDIT` e dois eventos pendentes na outbox, atomicamente. Abertura zero persiste somente a carteira. Não há endpoint de criação de lançamentos nesta coleção; transação e eventos não são campos da resposta de abertura.

## Paginação sem cursor vazio

- `limit` é opcional, padrão 50, permitido 1–100. `0`, `101`, `1.5`, `1e2`, `01`, valores vazios, parâmetros repetidos e campos extras são rejeitados.
- Ordem do ledger: crescente por `createdAt` e, em empate, por `id`. Cursor aponta para um lançamento existente da mesma carteira, codificado em base64url canônico; não é um offset.
- O request 05 envia `limit=1`. O parâmetro `cursor={{ledgerCursor}}` está desmarcado na aba Params, portanto não é enviado. `ledgerCursor` vazio no environment não causa `cursor=` no smoke padrão.
- Só habilite `cursor` depois de preencher `ledgerCursor` com um `nextCursor` não nulo retornado pela mesma carteira. Não envie `null`, vazio ou um cursor de outra carteira. Para voltar à primeira página, desmarque `cursor` novamente.
- Nos requests 01 a 19, cada wallet positiva tem somente a abertura e `nextCursor: null` é normal. As pastas de BET acrescentam débito em wallets próprias; request 29 lê ambos os lançamentos com o limite padrão.

## Erros exercitados

O corpo de erro de domínio/validação é `{ "code": "<CÓDIGO>" }`.

| Request | Status / código | Entrada ou situação |
| --- | --- | --- |
| 03 | 409 `WALLET_ALREADY_EXISTS` | Mesmo jogador e moeda já abertos. |
| 09 | 400 `INVALID_WALLET_PAYLOAD` | Campo extra `version`; campos desconhecidos não são ignorados. |
| 10, 14, 17 | 400 `INVALID_IDENTITY` | `not-a-uuid` no corpo ou caminho. |
| 11 | 400 `INVALID_AMOUNT` | `0.001` tem precisão inválida. |
| 12 | 400 `INVALID_AMOUNT` | `-0.01` falha no DTO HTTP, antes de chegar à regra de saldo negativo. |
| 13 | 400 `INVALID_CURRENCY` | `brl` em vez de moeda suportada. |
| 15, 16 | 404 `WALLET_NOT_FOUND` | UUID novo consultado sem abertura, tanto na carteira quanto no ledger. |
| 18, 19 | 400 `INVALID_LEDGER_QUERY` | Limite `0` ou cursor `bad`. |

Números JSON para `amount`, valores sem duas casas e campos obrigatórios ausentes também são rejeitados. Os exemplos de dinheiro da coleção permanecem strings, inclusive nos erros. `INITIAL_BALANCE_NEGATIVE` existe no filtro de domínio, mas não é a resposta da abertura HTTP negativa atual. Falhas inesperadas não viram códigos de negócio: os testes HTTP cobrem a resposta genérica 500, sem expor detalhes do banco; não há request artificial de falha interna na coleção.

## Fontes

Contratos: [rotas](../../src/wallets/wallet.controller.ts), [DTO de abertura](../../src/wallets/open-wallet.dto.ts), [DTO de paginação](../../src/wallets/ledger-query.dto.ts), [filtro de erros](../../src/shared/domain-error.filter.ts) e [WalletService](../../src/wallets/wallet-service.ts). Exemplos e expectativas: [testes HTTP de carteira](../../tests/integration/wallet-http.test.ts) e [testes HTTP de ledger](../../tests/integration/ledger-http.test.ts).

Referências Postman consultadas via Context7: [schema Collection v2.1](https://schema.getpostman.com/json/collection/v2.1.0/collection.json), [scripts e eventos da Collection SDK](https://github.com/postmanlabs/postman-collection/blob/develop/docs/concepts.md), [variáveis de environment](https://learning.postman.com/docs/use/send-requests/variables/environment-variables), [variáveis dinâmicas e UUID `$guid`](https://learning.postman.com/docs/use/send-requests/variables/use-variables) e [asserções `pm.test` / `pm.expect`](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect).
