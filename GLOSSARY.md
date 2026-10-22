# Glossário

Termos do comportamento atual. Requisitos ainda não entregues estão na [cobertura do desafio](PROGRESS.md); não são garantias deste glossário.

## Money

Objeto de valor imutável: centavos `bigint` e moeda, sem `number` ou conversão cambial. Entrada externa aceita somente decimal textual não negativo com duas casas; operações internas podem produzir negativos e exigem mesma moeda ([ADR-0001](docs/adr/0001-dinheiro-exato-e-dominio-isolado.md)).

## MoneyProps

Representação de transporte e serialização de `Money`: `{ amount: string, currency: string }`. `amount` preserva exatamente centavos; persistência SQL usa `numeric(30,2)`, com até 28 dígitos inteiros ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Moeda

Código reconhecido por `Intl.supportedValuesOf('currency')` do Bun/ICU, preservado em wallet, dinheiro, transação e ledger. Neste projeto a escala monetária é sempre de duas casas, sem conversão entre moedas.

## Player

Identidade UUID recebida como `playerId`, associada à wallet; não existe cadastro de jogador ou autenticação implementados. O par player/moeda identifica uma única wallet no banco.

## Wallet

Carteira identificada por UUID, com player, saldo, moeda, versão e datas encapsulados. Abertura e consulta estão disponíveis; operações de apostas não estão implementadas ([ADR-0001](docs/adr/0001-dinheiro-exato-e-dominio-isolado.md)).

## Saldo

Valor monetário materializado na wallet, não negativo. Na abertura positiva, corresponde ao `balanceAfter` do único crédito inicial; saldo zero não produz lançamento.

## Versão da wallet

Inteiro positivo persistido como `version`, iniciado em 1 e exposto em respostas e no evento `WalletBalanceChanged`. Não representa mecanismo de concorrência de movimentações já entregue.

## Abertura / OPENING

Abertura cria wallet com saldo inicial não negativo. Se positivo, cria também transação interna `OPENING` já `PROCESSED`, crédito no ledger e dois eventos na mesma transação SQL; se zero, cria somente wallet, sem transação financeira, ledger ou evento ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Transação financeira

Registro em `wager_transactions`, atualmente restrito a `OPENING`/`PROCESSED`. Não confundir com transação SQL: o nome da tabela e o evento `WagerTransactionProcessed` não significam que apostas, provedores, rodadas ou jogos estejam implementados.

## Transação SQL

Fronteira atômica de `EntityManager.fork().transactional()`: confirma todas as escritas da abertura antes da resposta ou desfaz todas em caso de falha anterior ao commit. Não se confunde com um registro de transação financeira ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Ledger / lançamento

Ledger é o histórico append-only em `wallet_ledger_entries`; cada `WalletLedgerEntry` registra transação, direção, valor positivo, saldo anterior, saldo posterior e data. Domínio e schema validam aritmética e moeda; trigger impede UPDATE, DELETE e TRUNCATE no uso normal ([ADR-0003](docs/adr/0003-auditoria-da-abertura.md)).

## CREDIT / DEBIT

Direções aceitas pelo lançamento: `CREDIT` soma o valor ao saldo anterior; `DEBIT` subtrai. O único fluxo financeiro implementado produz `CREDIT` de abertura; aceitar `DEBIT` no modelo não entrega um caso de uso de débito.

## Evento de integração

Envelope versionado com `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt` e `data`. Abertura positiva gera `WagerTransactionProcessed` e `WalletBalanceChanged`, serializados com `MoneyProps` e persistidos na outbox, não publicados.

## Correlação

`correlationId` liga os dois eventos de abertura à mesma transação interna OPENING; `aggregateId` é o ID da wallet. Não é identidade de provedor ou chave de idempotência externa.

## Outbox

Tabela `outbox_messages` que persiste eventos junto da abertura, com `published_at` nulo. Publisher, publicação, retries e inbox não estão implementados; outbox persistida não comprova entrega a consumidor ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Unit of Work / flush

Unit of Work acompanha registros e organiza envio ao banco; `flush` executa SQL dentro da transação aberta, sem antecipar commit. Atomicidade e integridade continuam dependendo da transação e das constraints ([ADR-0004](docs/adr/0004-contrato-http-e-ambiente-reproduzivel.md)).

## Reidratação

Reconstrução de estado persistido por `rehydrate`, preservando saldo, versão e datas sem repetir abertura ou reaplicar validações de criação. O mapeamento ORM permanece separado das classes de domínio.

## Cursor / keyset

Cursor é UUID do último lançamento retornado, codificado em base64url canônico e validado na mesma wallet; não é autorização. Keyset retoma ordem crescente `(created_at, id)` preservando precisão do timestamp no PostgreSQL, sem snapshot entre requests ([ADR-0005](docs/adr/0005-consulta-estavel-do-ledger.md)).

## Duplicata de abertura

Tentativa de criar outra wallet para o mesmo player/moeda, arbitrada pela constraint única e respondida com 409 `WALLET_ALREADY_EXISTS`. Não há replay idempotente da resposta de abertura nem idempotência de apostas entregue.
