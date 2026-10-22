# Contratos HTTP no Postman

Material para executar e avaliar a API atual, sem instalar dependências ou publicar coleções. Visão geral e preparação da aplicação: [README](../../README.md). Decisões e limites: [ARCHITECTURE](../../ARCHITECTURE.md).

## Importação

1. Prepare banco, migrations e aplicação conforme o README; espere a API estar pronta.
2. Em **Import** no Postman, importe [wallets.postman_collection.json](wallets.postman_collection.json) e [local.postman_environment.json](local.postman_environment.json).
3. Selecione o environment **Wallet HTTP — Local**. `baseUrl` começa em `http://127.0.0.1:3000`, sem barra final; ajuste para a porta publicada localmente, se necessário.
4. Use **Send** na sequência abaixo ou o Collection Runner com as três pastas em ordem e uma iteração. Os scripts ficam em **Pre-request** e **Post-response**; resultados aparecem em **Test Results**.

Não há credenciais no environment nem autenticação nos endpoints atuais. Use ambiente local descartável: cada envio de abertura válida cria dados persistentes; a coleção não limpa o banco e não existe endpoint HTTP de exclusão.

## Sequência de smoke

| Ordem / requests | Resultado esperado |
| --- | --- |
| **01 — Abrir carteira positiva** | 201; gera `playerId` UUID novo, abre com `9007199254740993.01 BRL` e captura `walletId`. |
| **02 — Consultar carteira positiva** | 200; mesma identidade, dinheiro exato e versão 1. |
| **03 — Repetir abertura — duplicata 409** | 409 `WALLET_ALREADY_EXISTS`; reutiliza o mesmo `playerId` e BRL, sem gerar UUID novo. |
| **04 — Consultar carteira após duplicata** | 200; saldo e versão não mudaram. |
| **05 — Consultar ledger positivo** | 200; exatamente um CREDIT, saldo anterior `0.00`, saldo posterior igual à abertura, `nextCursor: null`. |
| **06 — Abrir carteira zero** | 201; usa `zeroPlayerId` e `zeroWalletId`, preservando as variáveis do cenário positivo. |
| **07 — Consultar carteira zero** | 200; saldo `0.00 BRL`, versão 1. |
| **08 — Consultar ledger vazio** | 200; `{ "items": [], "nextCursor": null }`. |
| **09–19 — Erros do contrato** | 400, 404 ou 409 conforme o cenário, com código exato verificado pelos scripts. |

Para um smoke completo, execute **01–19**. Os requests **18–19** dependem de **01**; **02–05** também. Os requests **07–08** dependem de **06**. Os demais erros são independentes. Para repetir somente a duplicata, reenvie **03**, não **01**: **01** sempre troca `playerId`, limpa `walletId` antigo e cria outra carteira. UUID e ID de carteira só são capturados no environment selecionado; não use variáveis homônimas em dados de iteração.

Os scripts verificam status, códigos de erro, identidade, versão, strings monetárias exatas e conteúdo do ledger. Eles não inspecionam tabelas internas nem comprovam concorrência, rollback ou publicação de eventos; esses comportamentos exigem os testes de integração do repositório. Exemplos salvos nas respostas são ilustrativos, derivados dos contratos e testes, não capturas de um smoke executado.

## Formatos e respostas

- **`POST /wallets`** recebe `{ "playerId": "<UUID>", "initialBalance": { "amount": "1.00", "currency": "BRL" } }` e retorna **201** com `{ "id": "<UUID>", "playerId": "<UUID>", "balance": { "amount": "1.00", "currency": "BRL" }, "version": 1 }`.
- **`GET /wallets/:walletId`** retorna **200** com o mesmo formato de carteira. Não há datas ou transação na resposta da carteira.
- **`GET /wallets/:walletId/ledger`** retorna **200** com `items` e `nextCursor`. Cada item contém `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter` e `createdAt`. Os três valores monetários são objetos `{ "amount": "...", "currency": "BRL" }`; `createdAt` é uma string de data/hora.

`amount` é sempre string decimal não negativa com exatamente duas casas, sem notação exponencial nem zeros à esquerda além de `0.00`. Não converta dinheiro para `Number`; o valor positivo do smoke exercita precisão acima de `Number.MAX_SAFE_INTEGER`. A moeda deve pertencer a `Intl.supportedValuesOf('currency')`; `BRL` é válido, `brl` não. `playerId` e IDs de carteira precisam seguir o formato UUID. A unicidade da abertura é por **jogador e moeda**.

Abertura positiva persiste carteira, uma transação `OPENING` processada, um lançamento `CREDIT` e dois eventos pendentes na outbox, atomicamente. Abertura zero persiste somente a carteira. Não há endpoint de criação de lançamentos nesta coleção; transação e eventos não são campos da resposta de abertura.

## Paginação sem cursor vazio

- `limit` é opcional, padrão **50**, permitido **1–100**. `0`, `101`, `1.5`, `1e2`, `01`, valores vazios, parâmetros repetidos e campos extras são rejeitados.
- Ordem do ledger: crescente por `createdAt` e, em empate, por `id`. Cursor aponta para um lançamento existente da **mesma carteira**, codificado em base64url canônico; não é um offset.
- O request **05** envia `limit=1`. O parâmetro `cursor={{ledgerCursor}}` está **desmarcado** na aba **Params**, portanto não é enviado. `ledgerCursor` vazio no environment não causa `cursor=` no smoke padrão.
- Só habilite `cursor` depois de preencher `ledgerCursor` com um `nextCursor` não nulo retornado pela mesma carteira. Não envie `null`, vazio ou um cursor de outra carteira. Para voltar à primeira página, desmarque `cursor` novamente.
- **OPENING é a única escrita atual**: cada carteira positiva tem apenas um lançamento. Por isso, mesmo com `limit=1`, `nextCursor: null` é normal, não falta de paginação. Abertura zero tem ledger vazio. O smoke não inventa uma segunda página nem semeia registros via SQL.

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

Contratos: [rotas](../../src/app.ts), [DTO de abertura](../../src/open-wallet.dto.ts), [DTO de paginação](../../src/ledger-query.dto.ts), [filtro de erros](../../src/domain-error.filter.ts) e [WalletService](../../src/wallet-service.ts). Exemplos e expectativas: [testes HTTP de carteira](../../tests/integration/wallet-http.test.ts) e [testes HTTP de ledger](../../tests/integration/ledger-http.test.ts).

Referências Postman consultadas via Context7: [schema Collection v2.1](https://schema.getpostman.com/json/collection/v2.1.0/collection.json), [scripts e eventos da Collection SDK](https://github.com/postmanlabs/postman-collection/blob/develop/docs/concepts.md), [variáveis de environment](https://learning.postman.com/docs/use/send-requests/variables/environment-variables), [variáveis dinâmicas e UUID `$guid`](https://learning.postman.com/docs/use/send-requests/variables/use-variables) e [asserções `pm.test` / `pm.expect`](https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/pm-test-expect).
