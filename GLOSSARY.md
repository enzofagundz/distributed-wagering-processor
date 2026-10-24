# Glossário

Este glossário descreve o comportamento atual. O que ainda não foi implementado aparece em [limitações e lacunas](ARCHITECTURE.md#limitações-e-lacunas) e não faz parte das garantias descritas aqui.

## Money

Objeto de valor imutável: centavos `bigint` e moeda, sem `number` ou conversão cambial. Entrada externa aceita somente decimal textual não negativo com duas casas; operações internas podem produzir negativos e exigem mesma moeda ([ADR-0001](docs/adr/0001-dinheiro-exato-e-dominio-isolado.md)).

## MoneyProps

Representação de transporte e serialização de `Money`: `{ amount: string, currency: string }`. `amount` preserva exatamente centavos; persistência SQL usa `numeric(30,2)`, com até 28 dígitos inteiros ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Moeda

Código reconhecido por `Intl.supportedValuesOf('currency')` do Bun/ICU, preservado em wallet, dinheiro, transação e ledger. Neste projeto a escala monetária é sempre de duas casas, sem conversão entre moedas.

## Player

Identidade UUID recebida como `playerId`, associada à wallet. Não existe cadastro de jogador. A autenticação das rotas HTTP é feita por IdP externo (Keycloak), com o desenho em [Autenticação](ARCHITECTURE.md#autenticação) e no [ADR-0008](docs/adr/0008-autenticacao-com-keycloak.md); o domínio valida a identidade do jogador, não autentica. O par player/moeda identifica uma única wallet no banco.

## Wallet

Carteira identificada por UUID, com player, saldo, moeda, versão e datas encapsulados. Abertura, consulta, débito de BET e crédito de WIN, REFUND e ROLLBACK estão disponíveis. `debit` e `credit` não devolvem só a wallet: devolvem o par imutável descrito em [Movimento](#movimento), sem alterar a instância que recebeu a chamada ([processamento de BET](ARCHITECTURE.md#processamento-de-bet)).

## Movimento

Par imutável `WalletMovement` com a wallet resultante e o lançamento de ledger; o lançamento fica `null` quando o saldo não mudou. `Wallet.open`, `Wallet.debit` e `Wallet.credit` devolvem o par, então mover saldo e escrever auditoria são o mesmo ato. A transação e o lançamento recebem a identidade de quem chama, porque o agregado não gera UUID. Operação rejeitada não devolve par. O lançamento existe se e somente se o saldo mudou, e a abertura zero é o único caso de par com `entry` nulo ([movimento atômico](ARCHITECTURE.md#movimento-atômico)).

## Saldo

Valor monetário materializado na wallet, não negativo. Abertura positiva gera crédito inicial; BET processada gera débito. Deve corresponder à soma assinada do ledger. Abertura zero não produz lançamento.

## Versão da wallet

Inteiro positivo persistido como `version`, iniciado em 1 e exposto em respostas e no evento `WalletBalanceChanged`. Incrementa quando o saldo muda, seja por BET, WIN, REFUND ou ROLLBACK; rejeição, LOSS e pendência não incrementam. Lock pessimista da wallet controla concorrência, não comparação otimista de versão.

## Abertura / OPENING

Abertura cria wallet com saldo inicial não negativo. `Wallet.open` recebe a identidade da transação `OPENING` e a do lançamento, e devolve o par. Se o saldo for positivo, o par traz um crédito no ledger e o serviço persiste também a transação interna `OPENING` já `PROCESSED` e dois eventos na mesma transação SQL; se for zero, o par traz `entry` nulo e só a wallet é persistida, sem transação financeira, ledger ou evento ([ADR-0002](docs/adr/0002-persistencia-e-concorrencia-da-abertura.md)).

## Transação financeira

Registro em `wager_transactions`: OPENING/PROCESSED ou BET/PROCESSED e BET/REJECTED. BET identifica provider, operação externa, player, wallet, rodada e jogo; saldo observado e falha ficam persistidos. Não confundir com transação SQL.

## Transação SQL

Fronteira atômica de `EntityManager.fork().transactional()`: confirma todas as escritas da abertura ou BET antes da resposta, ou desfaz todas em caso de falha anterior ao commit. Não se confunde com registro de transação financeira.

## Ledger / lançamento

Ledger é o histórico append-only em `wallet_ledger_entries`; cada `WalletLedgerEntry` registra transação, direção, valor positivo, saldo anterior, saldo posterior e data. Lançamento novo só nasce pela factory `WalletLedgerEntry.create`, que valida identidade, valor positivo, moeda, saldos não negativos e a aritmética; por isso o par produzido pela wallet não pode nascer desbalanceado. Domínio e schema repetem essas garantias, e o trigger impede UPDATE, DELETE e TRUNCATE no uso normal ([ADR-0003](docs/adr/0003-auditoria-da-abertura.md)).

## CREDIT / DEBIT

Direções aceitas pelo lançamento: `CREDIT` soma o valor ao saldo anterior; `DEBIT` subtrai. A direção é consequência da operação: `credit` produz CREDIT; `debit` produz DEBIT. Abertura positiva produz CREDIT; BET processada produz DEBIT. BET rejeitada não gera lançamento.

## Evento de integração

Envelope com `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version` e `data` com MoneyProps; `causationId` é opcional. Eventos confirmados na outbox são publicados no SQS com a mesma identidade; movimento financeiro gera `WalletBalanceChanged`, rejeição gera `WagerTransactionRejected` sem evento de saldo.

## Correlação

`correlationId` liga eventos à transação financeira OPENING ou BET; `aggregateId` é o ID da wallet. Não é identidade de provedor ou chave de idempotência externa.

## Outbox

Tabela `outbox_messages` que persiste eventos na mesma transação SQL da operação e só recebe `published_at` após envio ao SQS. `OutboxMessage` é a classe de domínio correspondente: `enqueue` monta o registro a partir do evento de integração, `scheduleRetry` incrementa tentativas e agenda o próximo envio, e `markPublished` encerra a mensagem. Falha conserva a pendência; entrega pode repetir o mesmo `eventId`, e consumidores precisam deduplicar por eventId (ver [publicação da outbox](ARCHITECTURE.md#publicação-da-outbox)).

## Unit of Work / flush

Unit of Work acompanha registros e organiza envio ao banco; `flush` executa SQL dentro da transação aberta, sem antecipar commit. Atomicidade e integridade continuam dependendo da transação e das constraints ([ADR-0004](docs/adr/0004-contrato-http-e-ambiente-reproduzivel.md)).

## Reidratação

Reconstrução de estado persistido por `rehydrate`, preservando saldo, versão e datas sem repetir abertura ou reaplicar validações de criação. O mapeamento ORM permanece separado das classes de domínio.

## Cursor / keyset

Cursor é UUID do último lançamento retornado, codificado em base64url canônico e validado na mesma wallet; não é autorização. Keyset retoma ordem crescente `(created_at, id)` preservando precisão do timestamp no PostgreSQL, sem snapshot entre requests ([ADR-0005](docs/adr/0005-consulta-estavel-do-ledger.md)).

## Duplicata de abertura

Tentativa de criar outra wallet para o mesmo player/moeda, arbitrada pela constraint única e respondida com 409 `WALLET_ALREADY_EXISTS`. Não há replay da abertura.

## Replay de BET

Reenvio com mesma chave e hash de negócio devolve identidade, status e saldo observado persistidos, com `idempotentReplay: true`, sem novo efeito financeiro ou evento. Payload divergente conflita; outra chave para identidade externa existente também. Algoritmo e escopos: [idempotência de BET](ARCHITECTURE.md#idempotência-de-bet).

## Hash de negócio

SHA-256 hexadecimal minúsculo do JSON compacto dos campos financeiros da transação, em ordem fixa, calculado por `WagerTransaction.create` depois de normalizar wallet, player e dinheiro. `rehydrate` recebe o valor persistido sem recalcular, e `matchesPayload` decide entre replay e conflito. Não é o hash do envelope da inbox.

## Hash do envelope

SHA-256 do envelope completo da mensagem SQS, com chaves ordenadas recursivamente, incluindo `messageId` e `idempotencyKey`. Detecta reutilização divergente do mesmo messageId. Reordenar as chaves do JSON recebido não muda o hash. Fica separado do hash de negócio, que cobre só os campos financeiros.

## Inbox de BET

Registro em `inbox_messages`, único por consumidor e messageId, que confirma hash do envelope e resultado junto da operação financeira. Entrega repetida retorna o resultado original; reutilização divergente do ID é conflito (ver [ADR-0007](docs/adr/0007-inbox-atomica-de-bet.md)).
