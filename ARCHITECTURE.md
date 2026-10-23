# Arquitetura

Este documento descreve a implementação atual. Os requisitos estão no [enunciado](README_TECHNICAL_CHALLENGE.md), e a cobertura e as pendências, em [PROGRESS](PROGRESS.md). O [glossário](GLOSSARY.md) define os termos do domínio. Os ADRs vinculados abaixo registram decisões e alternativas.

## Mapa do código

| Área | Arquivos | Responsabilidade |
|---|---|---|
| Bootstrap | `src/main.ts` | Inicializa ORM/HTTP; fecha aplicação e pool em sinais ou falha de startup |
| Criação da aplicação | `src/create-application.ts` | Recebe ORM do chamador e cria aplicação Nest |
| Composição | `src/app.module.ts`, `src/{wallets,wagering,outbox}/*.module.ts` | Módulo raiz compõe funcionalidades; cada módulo registra controller e serviço |
| Transporte | `src/wallets/wallet.controller.ts`, `src/wallets/*dto.ts` | Wallets, reconciliação e métrica Prometheus; validação estrutural |
| Erros compartilhados | `src/shared/domain-error.filter.ts` | Tradução global de erros conhecidos, registrada uma vez pelo módulo raiz |
| Caso de uso e leitura | `src/wallets/wallet-service.ts` | Abertura atômica, reidratação, ledger keyset e reconciliação em snapshot único |
| Submissão de BET/WIN/LOSS/REFUND/ROLLBACK | `src/wagering/` | Contrato HTTP, lock da wallet, operações, referências e persistência atômica |
| Domínio | `src/domain/` | Money, Wallet, WagerTransaction, WalletLedgerEntry e eventos; sem NestJS/ORM |
| Persistência | `src/persistence/persistence.module.ts`, `*record.ts`, `config.ts` | Provider MikroORM exportado explicitamente, EntitySchema e configuração |
| Schema | `src/persistence/migrations/` | Constraints, FKs, trigger append-only e índices versionados |
| Verificação | `tests/domain/`, `tests/integration/` | Invariantes, constraints, atomicidade e fronteira HTTP com PostgreSQL real |

## Composição e injeção

`createApplication(orm)` monta `AppModule.register(orm)`, que importa `WalletsModule.register(orm)`, `WageringModule.register(orm)` e `OutboxModule.register(orm)`. Os módulos importam `PersistenceModule.register(orm)`, que exporta o token `MikroORM`; factories explícitas injetam a mesma instância fornecida pelo chamador. Não há provider global, conexão adicional por funcionalidade, configuração mutável compartilhada ou Repository intermediário. Providers de um módulo pai não ficam automaticamente visíveis nos filhos.

Controller recebe HTTP e delega; DTO valida estrutura; serviço coordena domínio e persistência. `Money`, `Wallet` e `WalletLedgerEntry` mantêm invariantes fora do NestJS, e `EntitySchema` continua separado do domínio. Para quem vem de Laravel: controller e service têm papéis semelhantes, mas módulo Nest declara a composição e a visibilidade de dependências; `WalletService` pode acessar ORM diretamente, sem transformar objetos de domínio em models Eloquent. Esse layout é convenção adotada, não obrigação de diretórios do framework.

Chamador continua dono do ORM: execução inicializa em `main.ts`, testes fornecem seus próprios bancos, e `app.close()` não fecha o pool emprestado. Startup com falha ou SIGINT/SIGTERM fecha HTTP antes do pool; ambos os sinais compartilham o mesmo encerramento para não fechar duas vezes. Falhas de criação Nest são propagadas ao chamador, sem saída forçada antes da limpeza. Migrations continuam explícitas.

Nest Boost 0.4.0 exige export de classe, não aceita objeto `DynamicModule`. `PreviewAppModule` compõe a mesma cadeia sem ORM fornecido; a factory padrão fica em persistência, sem executar `databaseConfig` nem inicializar PostgreSQL durante o preview nativo do Nest. `nest-boost.json` aponta para essa classe; `evaluate` permanece desativado. Essa entrada é somente para inspeção: execução e testes usam `createApplication(orm)`. Inspeção de DI não substitui HTTP real com PostgreSQL.

O [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) registra a decisão e as alternativas. Os contratos financeiros e o ponto de teste permanecem os mesmos; a reorganização não adiciona testes de wiring.

## Abertura de wallet

```mermaid
sequenceDiagram
    participant C as Cliente HTTP
    participant H as Controller e DTO
    participant S as WalletService
    participant D as Domínio
    participant P as PostgreSQL
    C->>H: POST /wallets
    H->>S: Payload validado
    S->>D: Money.from e Wallet.open
    D-->>S: Wallet e lançamento se saldo positivo
    S->>P: BEGIN
    S->>P: Persistir wallet
    opt Saldo positivo
        S->>P: Persistir OPENING PROCESSED
        S->>P: Persistir CREDIT e dois eventos outbox
    end
    S->>P: COMMIT
    S-->>C: 201 com wallet
```

Falha antes do commit desfaz todas as escritas. `persist(...).flush()` envia SQL dentro da transação, não antecipa commit. Abertura zero persiste somente wallet; ambas começam em versão 1. OPENING é interna, sem IDs fictícios de provedor, rodada ou jogo, e nasce persistida como PROCESSED.

A constraint única `(player_id, currency)` resolve aberturas concorrentes no PostgreSQL; duplicatas retornam 409. Abertura não reproduz resultado original; BET usa o replay descrito abaixo. O publisher consome a outbox após o commit, conforme a seção de publicação abaixo.

## Publicação da outbox

`OutboxModule` injeta o ORM existente e um `SQSClient` v3 no `OutboxPublisher`. `main.ts` inicia as varreduras após abrir HTTP. Encerramento espera a execução em andamento antes de fechar o ORM; `app.close()` também para o publisher e destrói o cliente SQS.

Cada varredura tenta até 100 registros, com uma transação SQL por evento. `SELECT ... FOR UPDATE SKIP LOCKED` escolhe a primeira linha com `published_at IS NULL` e agenda vencida (ou ausente), ordenada por `occurred_at, id`. Outra conexão não enxerga eventos ainda sem commit. O publisher envia `payload` como JSON sem reconstruir identidade, valores ou datas, e só depois de `SendMessage` retornar atualiza `published_at` com o relógio do banco. Falha SQL desfaz a transação do publisher; o evento conserva seu estado anterior. O lock pertence à linha de outbox, sem bloquear wallet ou manter aberta a transação financeira.

A fila de integração é standard, criada no LocalStack pelo Compose. O SDK faz uma tentativa por envio (`maxAttempts: 1`), com abort após cinco segundos. O próximo ciclo ocorre um segundo após o anterior terminar. Falha de envio incrementa `attempts` e persiste `next_attempt_at` na mesma transação que detém o lock. O backoff é `min(300, 2^attempts)` segundos: 2, 4, 8, 16, 32, 64, 128, 256 e 300 nas seguintes. O cálculo e a elegibilidade usam o relógio do PostgreSQL; o expoente é limitado antes do cálculo. A contagem registra falhas de envio, continua após sucesso e não limita a recuperação. Não há descarte nem DLQ de saída: indisponibilidade prolongada acumula eventos para envio posterior. Não há jitter neste incremento.

Após agendar o retry, o lote continua sobre outros eventos elegíveis, até 100 tentativas por varredura. Sucesso define `published_at` e limpa a agenda. Erro SQL interrompe o lote. A chamada ao Logger Nest inclui `OutboxPublicationFailed`, tipo do erro e, para falha de envio, `eventId`, sem payload ou credenciais. O `logger: false` de `createApplication` silencia essa chamada no bootstrap; emissão operacional de logs continua pendente. Reinício lê contagem e agenda do banco, sem antecipar retries futuros. Queda antes de confirmar o agendamento desfaz apenas essa tentativa; a linha continua recuperável.

A migration `20261023000700` adiciona contagem não negativa, agenda finita e índice parcial para pendências. Registros antigos começam com zero falhas e sem prazo, prontos para envio. O down preserva envelopes e marcações, mas remove o histórico de tentativas e a agenda; após novo up, pendências voltam a ser imediatamente elegíveis. Pare publishers durante rollback do schema.

A entrega é at-least-once. Se o SQS aceitar a mensagem e o processo morrer antes do commit da marcação, haverá reenvio do mesmo `eventId`. Os consumidores devem deduplicar por essa identidade. Não há garantia de ordem de entrega; `walletVersion` permite reconhecer a sequência financeira. `SKIP LOCKED` evita disputa da mesma linha durante uma execução. O lock é a reserva: commit, rollback ou fechamento da conexão o libera, sem lease persistido ou tarefa de limpeza. O worker vivo pula a linha reservada e processa outras; uma varredura posterior retoma a linha abandonada. A recuperação depende de o PostgreSQL detectar a conexão encerrada; uma partição de rede pode atrasar essa detecção. O timeout de envio limita a chamada ao SQS, não substitui timeouts de conexão do banco.

O ticket 17 verifica dois processos com locks simultâneos, SIGKILL após envio aceito e antes da marcação, progresso do sobrevivente e reenvio do mesmo envelope. Um consumidor de verificação grava o efeito em tabela com chave primária `event_id`, usando `INSERT ... ON CONFLICT DO NOTHING`: cinco entregas produzem quatro efeitos persistidos. Um consumidor real deve confirmar a deduplicação e seu efeito na mesma transação, antes do ack. A prova não implementa inbox de produção nem garante um limite global de duplicatas da fila standard.

Mantivemos o lock transacional já existente em vez de introduzir claim com prazo: um lease exigiria expiração, renovação e proteção contra um worker antigo ainda ativo. A contrapartida é manter uma conexão/transação durante o envio. Referências consultadas via Context7: [PostgreSQL 17 — SKIP LOCKED para consumidores de fila](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE) e [duração dos locks](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS). Setup e cenário reproduzível no [README](README.md#publicar-e-inspecionar-eventos); resultados na [verificação](docs/verification.md#publishers-concorrentes--2026-10-23).

O envelope existente contém `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt` ISO-8601, `version` e `data` com MoneyProps. `causationId` é opcional e atualmente omitido pelos produtores. `WalletBalanceChanged` inclui wallet, transação, direção, valor, saldos anterior/posterior e versão da wallet. Rejeição produz `WagerTransactionRejected`, sem evento de saldo.

Alternativa descartada: enviar no handler HTTP após o commit, pois uma queda nesse intervalo perderia o evento. Marcar antes de enviar também perderia eventos em caso de erro de rede. Manter um lock de outbox durante um envio limitado evita claims com lease neste incremento, ao custo de ocupar uma conexão durante a chamada. Retry somente em memória foi descartado porque reinício perderia a agenda.

Referências consultadas via Context7: [AWS SDK v3](https://github.com/aws/aws-sdk-js-v3), [URLs SQS no LocalStack](https://docs.localstack.cloud/aws/services/sqs/) e [hooks de inicialização](https://docs.localstack.cloud/aws/capabilities/config/initialization-hooks/). Comandos no [README](README.md#publicar-e-inspecionar-eventos); resultados em [verificação](docs/verification.md#publicação-da-outbox--2026-10-23).

## Garantias e limites

- Dinheiro: centavos `bigint` no domínio; `numeric(30,2)` na persistência, lido como string. Limite SQL: 28 dígitos inteiros; overflow falha sem commit parcial. Nunca converter dinheiro para `number`.
- Domínio encapsula estado; factories criam e `rehydrate` reconstrói sem reaplicar transições. Validação HTTP não substitui invariantes do domínio.
- Banco protege saldo não negativo, unicidade, aritmética do ledger e consistência de identidade/moeda por FKs compostas. Trigger rejeita UPDATE, DELETE e TRUNCATE do ledger. Administrador capaz de remover trigger/schema não está contido por essa proteção.
- Correspondência saldo/ledger depende do caso de uso transacional; schema não promete impedir toda escrita administrativa arbitrária. Separação entre usuário de migrations e aplicação ainda é necessária antes de exposição real.
- Sem lock global. BET, WIN, LOSS, REFUND e ROLLBACK usam lock pessimista da wallet antes da leitura do saldo. Concorrência financeira de BET foi exercitada em três processos com pools independentes; isso não comprova os fluxos de mensageria.
- Eventos persistidos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`, com envelope versionado e MoneyProps. Publicação real, backoff persistido e provas de crash e concorrência dos publishers estão cobertos nos tickets 15–17.

## Processamento de BET

`POST /wagering/transactions` aceita BET, WIN, LOSS, REFUND e ROLLBACK e exige `Idempotency-Key`. OPENING continua interna. UUIDs são normalizados para minúsculas. Identificadores textuais têm até 200 caracteres, sem espaços nas extremidades ou controles; provider `internal` é reservado. Valor deve ser positivo, com duas casas e até 28 dígitos inteiros.

`externalWagerKinds`, em `src/domain/wager-transaction.ts`, é a lista imutável de kinds externos usada pelo domínio e pelo DTO. `ExternalWagerKind` deriva dessa lista; `WagerKind` acrescenta OPENING para persistência e eventos. Serviço e contratos reutilizam esses tipos. Subconjuntos dos eventos preservam suas restrições, como ausência de LOSS no evento de rejeição e na factory que recebe ledger. Comparações específicas continuam nas regras de negócio. Migrations mantêm listas históricas próprias: importar o contrato atual faria uma migration antiga mudar ao adicionar uma operação.

`WageringService.submit` usa um EntityManager novo por chamada e `transactional`. A primeira leitura da wallet usa `PESSIMISTIC_WRITE` (`SELECT … FOR UPDATE`). O lock dura até commit/rollback; a próxima aposta na mesma wallet espera e lê o saldo confirmado pela anterior. Wallets diferentes não compartilham lock financeiro. Alternativa: versão otimista com retry limitado; descartada neste incremento para evitar repetição do caso de uso após conflito.

O serviço valida player e moeda contra a wallet carregada antes de escrever. Provider tem validação de formato e nome reservado, não autenticação nem cadastro. A API permanece local e sem IdP.

Com saldo suficiente, `Wallet.debit` retorna nova wallet imutável com versão incrementada. SQL confirma BET PROCESSED, saldo observado, um DEBIT, saldo materializado e eventos Processed/BalanceChanged juntos. Sem saldo, confirma BET REJECTED com `INSUFFICIENT_FUNDS` e evento Rejected; saldo, versão e ledger não mudam. Resposta sai após commit. Falha ao gravar qualquer evento desfaz também escritas anteriores. A publicação ocorre no worker separado, após commit.

`WagerTransaction.create` nasce PENDING; `markProcessed` e `reject` levam a estados terminais, que recusam novas transições. `rehydrate` recompõe estado sem repetir regras. BET e LOSS persistem somente estados terminais; WIN, REFUND e ROLLBACK também podem persistir PENDING_REFERENCE, conforme seções abaixo. Código de falha existe apenas na rejeição.

Migration 004 mantém uma OPENING por wallet por índice único parcial. Unicidades de `(provider_id, external_transaction_id)` e `idempotency_key` impedem segundo efeito financeiro. O saldo observado fica persistido. FKs compostas, checks de não-negatividade e trigger append-only permanecem ativos. `down` da migration 004 recusa execução com BET persistida, antes de remover colunas ou constraints.

## Idempotência de BET

Chave do header é obrigatória, global e sensível a maiúsculas; não é derivada automaticamente do payload. Identidade externa é única por `(providerId, externalTransactionId)`, também sensível a maiúsculas, sem escopo por wallet ou rodada. Outra chave para identidade externa existente retorna 409 `TRANSACTION_ALREADY_EXISTS`, mesmo com payload igual; não cria alias. Outro provider pode reutilizar external ID com chave nova.

`payloadHash` é SHA-256 em hexadecimal minúsculo dos bytes UTF-8 de JSON compacto. Campos aparecem nesta ordem lexicográfica: `externalTransactionId`, `gameId`, `kind`, `money`, `playerId`, `providerId`, `referenceExternalTransactionId` quando informada, `roundId`, `walletId`; dentro de `money`: `amount`, `currency`. Omitir referência omite também a propriedade no hash, preservando hashes das BETs existentes. UUIDs usam minúsculas e valor monetário usa duas casas. Strings seguem escaping de `JSON.stringify`, sem normalização Unicode. Espaços e ordem das propriedades no JSON recebido não entram no hash. Header, chave, IDs internos, timestamps e demais metadados HTTP ficam fora; campos extras no body continuam inválidos.

Resultado e hash são gravados junto de saldo, ledger e outbox. Antes de procurar wallet, o serviço consulta a chave persistida: hash diferente retorna `IDEMPOTENCY_CONFLICT`; hash igual retorna transactionId, status, failureCode e saldo observado originais, com `idempotentReplay: true`. Rejeição continua 422 no replay, sem reavaliar saldo. Replay de sucesso continua 201. Nenhum replay altera versão ou produz eventos.

Consulta inicial é otimização, não garantia de exclusão. Se duas instâncias não encontrarem a chave, constraints arbitram a corrida. Após rollback de qualquer uma das duas unicidades conhecidas, um EntityManager novo consulta a chave: se existir, compara hash e reproduz resultado; caso contrário, responde conflito externo. Isso evita depender da ordem em que o PostgreSQL verifica índices. Conflito de chave precede conflito externo; após validação estrutural e de domínio, também precede validação da wallet. Outra violação de unicidade continua erro inesperado.

Migration 005 (`20261023000100`) preenche hashes de BETs existentes a partir dos campos persistidos e exige hash de 64 caracteres hexadecimais em BET, nulo em OPENING. Reversão remove apenas coluna/check, sem apagar auditoria. Migração exige APIs paradas. Alternativa descartada: cache em memória, que não cobre reinício nem múltiplas instâncias; não foi criada tabela de reservas porque BET termina na mesma transação financeira.

Referência consultada para rollback, locks e novo EntityManager: [MikroORM 6.6 — transações](https://mikro-orm.io/docs/6.6/transactions). Evidências e limites atuais: [verificação de idempotência](docs/verification.md#idempotência-de-bet--2026-10-23); histórico do débito: [BET HTTP](docs/verification.md#bet-por-http--2026-10-22).

### Concorrência entre processos

Ticket 08 mantém a estratégia financeira existente, sem migration ou lock em memória. `tests/integration/wallet-concurrency.test.ts` inicia três processos Bun com portas dinâmicas e pools separados. A fixture obtém `WageringService` pelo container Nest; metade dos 50 envios entra por HTTP e metade chama `submit` por IPC. São chamadas ao mesmo caso de uso, não um consumidor SQS.

Uma transação de controle segura a linha da wallet antes do lote. O teste identifica cada processo por `application_name` e aguarda três nomes distintos com `pg_blocking_pids` não vazio. Contar somente esperas diretamente ligadas ao PID controlador seria incorreto: PostgreSQL pode enfileirar uma espera atrás de outra. O prazo de cinco segundos limita a falha da barreira, não define quando há concorrência.

Outro cenário mantém uma wallet bloqueada e confirma duas BET em wallets distintas nos outros processos antes de liberar o lock. Depois reconcilia todas. Não há benchmark: uma hot wallet continua serializada até o fim da transação, e suas chamadas podem ocupar conexões do pool. Mais instâncias não eliminam essa contenção.

Falha antes do commit desfaz a transação e libera o lock; depois do commit, resultado, saldo, ledger e outbox já estão persistidos. Se a resposta se perder, o reenvio usa resultado original e unicidades do banco, não estado do processo. Este ticket não simula morte entre commit e ack: inbox e consumidor SQS ainda estão pendentes. As provas dos publishers estão na seção de publicação da outbox.

Alternativa seria optimistic locking com retry limitado ou update condicionado. A prova multiprocesso não exigiu trocar o lock por linha já adotado. Referências: [PostgreSQL 17 — locks de linha](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) para duração e escopo; [Bun — IPC](https://bun.sh/docs/runtime/child-process#inter-process-communication-ipc) para comunicação da fixture, consultada via Context7 e exercitada no Bun 1.3.14. Evidências: [verificação do ticket 08](docs/verification.md#concorrência-entre-processos--2026-10-23).



## Crédito de WIN e referências

Decisão D-012, ticket 09 (§6.2–6.4, §7, §9 e §11): WIN reutiliza `WageringService.submit`, a chave global e o lock por wallet do BET. `Wallet.credit` aplica dinheiro exato, e a mesma transação SQL persiste WIN PROCESSED, saldo observado, CREDIT, saldo/versão e eventos Processed/BalanceChanged. Qualquer falha antes do commit desfaz o conjunto. A resposta sai depois do commit; replay lê o resultado persistido, sem creditar novamente.

Mapeamentos monetários usam instância explícita de `StringType` com `columnType: 'numeric(30,2)'`. PostgreSQL continua responsável pela representação numérica exata; ORM compara strings canônicas. O `DecimalType` instalado em 6.6.8 converte para `number` em `compareValues`, e deixou de detectar um crédito de `0.01` sobre `9007199254740993.01` no teste HTTP. Declarar apenas `type: 'string'` ou passar a classe `StringType` não bastou: discovery voltou a inferir DecimalType pela coluna. A instância explícita evita essa substituição, sem tipo monetário customizado nem alteração SQL.

Referência é opcional para WIN. Omissão significa prêmio independente, não referência faltante. Se `referenceExternalTransactionId` estiver presente, deve identificar BET no mesmo provider, player, wallet, moeda e rodada. A busca usa `(providerId, externalTransactionId)`: ID de outro provider não é resolvido por aproximação. WIN não é reversão; prêmio pode diferir do valor da BET e `gameId` não integra a regra de compatibilidade do §7, item 2.

| Referência informada | Resultado | Efeito financeiro |
|---|---|---|
| BET PROCESSED compatível | PROCESSED, HTTP 201 | Um CREDIT e versão incrementada |
| Identidade, moeda, rodada ou kind incompatível | REJECTED, HTTP 422, `REFERENCE_MISMATCH` | Nenhum; evento Rejected |
| BET terminal sem processamento | REJECTED, HTTP 422, `REFERENCE_NOT_PROCESSED` | Nenhum; evento Rejected |
| Não encontrada ou ainda não terminal | PENDING_REFERENCE, HTTP 202 | Nenhum; evento PendingReference |

Validação da wallet precede resolução da referência: player ou moeda incompatível com a própria wallet continua erro 400, sem transação aceita. Referência rejeitada fica auditada como rejeição de negócio, com saldo observado e sem ledger.

PENDING_REFERENCE mantém payload/hash, referência externa e saldo observado no aceite. Não tem `processedAt`; não gera ledger ou BalanceChanged. Replay e GET consultam o registro, sem tentar resolução, mesmo que a BET apareça depois. O worker resolve ou encerra a pendência conforme a [política de referências](#resolução-de-referências-pendentes). Não se deve tratar HTTP 202 como crédito concluído.

Alternativa descartada: ignorar referência opcional informada e creditar antes de validá-la. Isso aceitaria prêmio associado a outra wallet ou rodada. Exigir referência para todo WIN também restringiria o contrato além do enunciado. Publicar diretamente no broker após o crédito deixaria uma janela de perda; o caso de uso grava a outbox e deixa a publicação para o worker separado.

Migration `20261023000200` adiciona WIN, PENDING_REFERENCE, IDs de referência e checks de formato/estado. Uma FK composta liga o ID interno ao provider e ID externo resolvidos; rejeições por incompatibilidade preservam a referência para auditoria. O `down` restaura o contrato BET anterior somente quando não há WIN ou histórico de referência. Caso contrário, recusa a reversão sem apagar dados. Unicidades de chave/identidade externa, FKs financeiras e proteção append-only do ledger permanecem.

Referência consultada: [MikroORM 6.6 — transações e concorrência](https://mikro-orm.io/docs/6.6/transactions), para lock de linha dentro de transação explícita e rollback de flushes anteriores. Evidências executadas ficam em [WIN HTTP](docs/verification.md#win-por-http--2026-10-23).

## LOSS sem movimento

Decisão D-013, ticket 10 (§6.2–6.4, §7 e §11): LOSS reutiliza `WageringService.submit`, lock por wallet, hash e unicidades existentes. O lock fixa o saldo observado em relação às operações concorrentes. Não chama `Wallet.debit` ou `Wallet.credit`, não altera saldo, versão ou `updatedAt`, não cria ledger e não produz `WalletBalanceChanged`.

LOSS nasce PENDING e passa diretamente a PROCESSED. Resultado, saldo observado, `processedAt` e `WagerTransactionProcessed` são confirmados na mesma transação SQL. Transições após PROCESSED lançam `INVALID_TRANSACTION_STATE`, erro de programação; replay ocorre antes de qualquer nova transição. Falha ao inserir outbox desfaz também a transação de aposta. Após commit, reenvio devolve resultado original, mesmo se outra operação já mudou saldo.

Valor continua positivo e segue o contrato monetário comum, mas não exige saldo disponível. Referência não é aceita; LOSS registra resultado independente, sem buscar BET nem impor uma derrota por rodada. Essas restrições adicionais não constam do enunciado. Alternativa descartada: lançamento de valor zero ou novo débito, que alteraria auditoria e versão sem movimento financeiro.

Migration `20261023000300` amplia checks existentes sem relaxar contratos BET/WIN: LOSS exige identidade externa, hash, saldo observado e metadados terminais, sem referência ou failure code. `down` restaura checks anteriores apenas sem histórico LOSS; caso contrário, recusa sem apagar dados. A correspondência saldo/ledger continua sob responsabilidade do caso de uso transacional, não de um trigger novo.

HTTP retorna 201, inclusive no replay; validação e conflitos seguem códigos existentes. Os eventos são publicados pelo worker da outbox; entrada por SQS continua pendente. Referência consultada: [MikroORM 6.6 — transações](https://mikro-orm.io/docs/6.6/transactions). Resultados executados: [LOSS HTTP](docs/verification.md#loss-por-http--2026-10-23).


## Devolução de BET com REFUND

Decisão D-014, ticket 11 (§6.3, §7, §9 e §11): REFUND exige `referenceExternalTransactionId` e reutiliza resolução por provider/ID externo, lock da wallet, hash e replay existentes. O domínio aceita apenas BET PROCESSED do mesmo provider, player, wallet, moeda e rodada, com valor exatamente igual. `gameId` não integra a compatibilidade exigida no §7. Reversão parcial não é aceita.

Referência incompatível resulta em REJECTED com `REFERENCE_MISMATCH`; BET terminal sem processamento, `REFERENCE_NOT_PROCESSED`. Referência inexistente ou ainda não terminal resulta em PENDING_REFERENCE. Pendência e rejeição persistem saldo observado e evento correspondente, sem ledger, crédito ou incremento de versão. A validação da própria wallet ainda precede a referência: player/moeda divergente da wallet retorna 400 antes de aceitar a transação. Busca não atravessa providers; ID existente apenas em outro provider é referência ausente.

Após validar a referência e ainda sob lock da wallet, o serviço procura REFUND PROCESSED para a mesma BET. Nova tentativa com identidade própria é auditada como REJECTED com `REFERENCE_ALREADY_REFUNDED`. Migration `20261023000400` adiciona índice único parcial `wager_transactions_refund_reference_unique` sobre `reference_transaction_id` somente para REFUND PROCESSED. Essa é a garantia final contra dois créditos; pendências e rejeições não reservam a BET. O lock serializa tentativas válidas da mesma wallet e permite registrar rejeição de negócio, em vez de expor violação de unicidade como erro inesperado.

No sucesso, `Wallet.credit` devolve o valor integral; saldo/versão, REFUND PROCESSED, CREDIT e eventos Processed/BalanceChanged confirmam juntos. Flush não antecipa commit; falha na outbox desfaz inclusive a reserva no índice. Replay mantém identidade, status, failure code e saldo originais, sem consultar novamente a BET ou emitir evento. Replay de pendência não a resolve; o worker segue a [política de referências](#resolução-de-referências-pendentes).

Alternativa descartada: índice único sobre todas as tentativas, que faria uma rejeição por valor inválido impedir devolução válida posterior. Checar apenas no serviço, sem índice, deixaria a unicidade dependente da disciplina dos escritores. Não há lock adicional na BET: uma referência válida pertence à wallet já bloqueada.

Migration amplia os checks de kind, referência obrigatória, hash e metadados de status, sem mudar contratos anteriores. O `down` restaura BET/WIN/LOSS somente sem qualquer histórico REFUND; caso contrário, recusa sem apagar auditoria. Compatibilidade financeira da referência permanece no domínio; schema protege formato, vínculo provider/ID externo e unicidade, não toda escrita administrativa arbitrária.

Referências consultadas: [MikroORM 6.6 — transações e concorrência](https://mikro-orm.io/docs/6.6/transactions), para lock e rollback; [PostgreSQL 17 — índice único parcial](https://www.postgresql.org/docs/17/indexes-partial.html#INDEXES-PARTIAL-EX3), para permitir tentativas rejeitadas sem segundo sucesso. Evidências e limites: [REFUND](docs/verification.md#refund-de-bet--2026-10-23).

## Reversão de movimento com ROLLBACK

Decisão D-015, ticket 12 (§6.3, §7, §9 e §11): ROLLBACK exige referência externa e aceita BET, WIN ou REFUND PROCESSED. O domínio valida provider, identidade externa, player, wallet, moeda, rodada e valor integral. Jogo pode diferir. OPENING, LOSS e ROLLBACK são inelegíveis e resultam em `REFERENCE_MISMATCH`; referência terminal sem processamento resulta em `REFERENCE_NOT_PROCESSED`. Referência ausente ou não terminal fica PENDING_REFERENCE, sem movimento.

`WagerTransaction.ledgerDirectionFor` define a direção: BET é revertida com CREDIT; WIN e REFUND, com DEBIT. A verificação de saldo ocorre sob lock da wallet antes de aplicar o débito. Insuficiência gera REJECTED com `INSUFFICIENT_REVERSAL_FUNDS`, distinto de `INSUFFICIENT_FUNDS` da BET. Rejeição persiste saldo observado e evento Rejected, sem ledger ou incremento de versão.

Após resolver a referência, o serviço procura reversão PROCESSED do mesmo tipo sob o lock existente. Segunda tentativa ROLLBACK recebe `REFERENCE_ALREADY_ROLLED_BACK`. Migration `20261023000500` acrescenta `wager_transactions_rollback_reference_unique`, índice único parcial sobre a referência somente para ROLLBACK PROCESSED. REFUND mantém seu índice separado. As duas operações podem reverter a mesma BET uma vez cada: proibição cruzada ampliaria §7.4 sem base no enunciado. Tentativas rejeitadas ou pendentes não reservam sucesso.

Saldo/versão, ROLLBACK, ledger invertido e eventos Processed/BalanceChanged confirmam na mesma transação SQL. Falha de outbox antes do commit desfaz o conjunto, inclusive a reserva no índice; nova tentativa continua possível. Replay lê status, código e saldo originais, mesmo após reinício, sem reaplicar movimento ou resolver pendência. A resolução agendada reutiliza as mesmas regras na seção abaixo.

O schema amplia checks de kind, referência obrigatória, hash e estados, sem alterar migrations anteriores. Down recusa qualquer histórico ROLLBACK; sem histórico, restaura o contrato REFUND. Compatibilidade financeira continua no domínio; checks/FKs protegem formato e vínculo externo, não toda escrita administrativa arbitrária.

Alternativas descartadas: unicidade de todas as tentativas impediria correção após rejeição; unicidade compartilhada com REFUND proibiria operação permitida; checagem sem índice deixaria a exclusão dependente dos escritores. Não há segundo lock na referência, pois referência elegível pertence à wallet já bloqueada. Fontes: [MikroORM 6.6](https://mikro-orm.io/docs/6.6/transactions) e [PostgreSQL 17](https://www.postgresql.org/docs/17/indexes-partial.html#INDEXES-PARTIAL-EX3). Provas executadas e limites: [verificação](docs/verification.md#rollback-de-movimento--2026-10-23).

## Resolução de referências pendentes

Decisão D-016, tickets 13 e 14 (§6.3, §7.1 e §13): `WageringService.settle` concentra a aplicação financeira usada por `submit` e pela resolução. A resolução reidrata o registro `PENDING_REFERENCE` em vez de criar outra transação e reutiliza validação da referência, exclusão de reversões duplicadas e persistência financeira.

`PendingReferenceWorker` inicia em `src/main.ts` e para em `SIGTERM`/`SIGINT` antes de fechar o ORM. Cada execução lista apenas pendências com `reference_next_attempt_at <= at`, por `id`, em páginas de `PENDING_REFERENCE_PAGE_SIZE`. `PENDING_REFERENCE_INTERVAL_MS` controla a varredura, não substitui o backoff por operação. Não há rota HTTP para dispará-la. `resolvePendingReference`, `resolvePendingReferences` e `worker.runOnce` aceitam `Date` opcional; testes fornecem tempo explícito, sem sleeps para simular o backoff.

O corte de elegibilidade é fixo durante a varredura. Em produção, cada tentativa captura seu instante após obter o lock da wallet; espera por lock ou páginas anteriores não antecipa `processedAt` nem o próximo retry. Uma data explícita fixa também esse instante nos testes.

A resolução bloqueia a linha com `PESSIMISTIC_PARTIAL_WRITE` (`FOR UPDATE SKIP LOCKED`) e só segue se continuar pendente e vencida. Depois bloqueia a wallet com `PESSIMISTIC_WRITE`. Workers concorrentes pulam a linha bloqueada ou encontram seu próximo horário adiado/estado terminal. Os índices únicos parciais de REFUND/ROLLBACK e o lock da wallet continuam impedindo dois efeitos para a mesma referência.

### Política de tentativas e encerramento

A submissão inicial persiste `reference_attempts = 0` e `reference_next_attempt_at` igual ao horário do aceite. O primeiro retry fica imediatamente elegível, mas depende da próxima varredura. Cada tentativa vencida do worker incrementa o contador na mesma transação SQL do resultado. Chamada anterior ao horário, linha bloqueada ou status terminal resulta em `SKIPPED`, sem consumir tentativa.

Após a tentativa `n` continuar pendente, para `1 <= n < 10`, o próximo horário é o instante dessa tentativa mais `min(1000 * 2 ** (n - 1), 60000)` milissegundos. Os nove delays são `1, 2, 4, 8, 16, 32, 60, 60, 60` segundos, soma de 243 segundos desde o primeiro retry até a décima tentativa no agendamento ideal. Não é TTL: downtime, contenção, duração e intervalo das varreduras podem alongar esse tempo. Cada tentativa agenda a seguinte a partir de sua própria execução; reinício não dispara todas as tentativas atrasadas de uma vez.

O limite de dez tentativas encerra pendências sem depender da memória do worker. O backoff reduz consultas repetidas, e o teto de 60 segundos mantém novas oportunidades de resolução sem aumentar indefinidamente o intervalo. São valores fixos desta política, não uma promessa de prazo do provedor nem uma medição de carga. Alternativas descartadas: retry ilimitado manteria órfãs para sempre; TTL isolado consumiria a janela durante downtime, mesmo sem tentar a referência.

A resolução sempre consulta e valida a referência antes de verificar esgotamento, inclusive na décima tentativa:

| Situação na tentativa vencida | Resultado | Escritas |
|---|---|---|
| Referência ausente ou não terminal, tentativas 1–9 | Continua `PENDING_REFERENCE` | Contador e próximo horário; sem novo evento `PendingReference` |
| Referência ausente ou não terminal, tentativa 10 | `REJECTED`, `REFERENCE_NOT_FOUND` | Contador 10, saldo observado no término, `processedAt` e `WagerTransactionRejected`; sem ledger |
| Referência `PROCESSED` compatível, inclusive na tentativa 10 | Aplica regras financeiras existentes | Resultado, saldo/versão quando houver movimento, ledger e eventos juntos |
| Referência incompatível | `REJECTED`, `REFERENCE_MISMATCH` | Resultado e evento `Rejected`, sem ledger |
| Referência compatível `REJECTED` ou `FAILED` | `REJECTED`, `REFERENCE_NOT_PROCESSED` | Resultado e evento `Rejected`, sem ledger |
| Ainda não vencida, bloqueada ou já terminal | `SKIPPED` | Nenhuma |

Uma referência existente que nunca sai de estado não terminal também esgota as dez tentativas. `FAILED` já é reconhecido pelo domínio como terminal sem processamento; o schema atual ainda não persiste esse estado. A cobertura desse ramo é de domínio, não evidência de um fluxo SQL de `FAILED`. Uma referência incompatível continua `REFERENCE_MISMATCH`, mesmo se também estiver rejeitada.

Replay e GET durante a pendência preservam o saldo observado no aceite e não disparam resolução nem consomem tentativas. No término, `observedBalance` passa a registrar o saldo da wallet sob lock naquele instante, depois do movimento se houver. GET retorna 200; replay retorna 201 no sucesso ou 422 na rejeição, com status, código e saldo terminal persistidos, mesmo depois de novas operações ou reinício.

`REFERENCE_NOT_FOUND` é definitivo, inclusive quando significa referência ainda não terminal ao esgotar o limite. O provedor deve corrigir a referência e usar nova identidade externa e chave para uma nova operação; nova chave com a identidade antiga continua conflito. Replay nunca reabre nem credita a transação encerrada se a referência chegar depois.

Status, contador, próximo horário, saldo observado terminal e evento de rejeição confirmam no mesmo commit. Encerramento não altera saldo, versão ou ledger. Falha SQL, inclusive na outbox da décima tentativa, desfaz todas essas escritas e não consome a tentativa. Reinício retoma contador e próximo horário persistidos; depois do commit, estados terminais deixam a varredura e não repetem efeito ou evento. Publicação da outbox não faz parte do worker.

Migration `20261023000600` adiciona `reference_attempts` de 0 a 10 e `reference_next_attempt_at`, finito e obrigatório apenas em `PENDING_REFERENCE`; pendência exige contador menor que 10. Estados terminais ficam sem próximo horário. Pendências anteriores recebem contador zero e horário `created_at`, sem perda de identidade, hash ou saldo do aceite. O índice parcial `(reference_next_attempt_at, id)` atende à busca de pendências vencidas. `down` recusa histórico com `REFERENCE_NOT_FOUND`; sem esse histórico, remove campos/índice e restaura checks anteriores. Exige APIs paradas.

O publisher envia os eventos ao SQS; inbox e consumo de operações continuam pendentes. A segurança entre instâncias vem do PostgreSQL, não de scheduler distribuído. Cenários SQL/HTTP não comprovam ack, redelivery ou publicação. Testes focais e setup: [README](README.md#resolver-referência-pendente). Registro de execução do ticket 14: [expiração de referências](docs/verification.md#expiração-de-referências--2026-10-23); resultados devem ser lidos nessa seção, sem extrapolar evidências históricas do ticket 13.

Referências dos locks mantidas da resolução: [MikroORM 6.6 — pessimistic locking](https://mikro-orm.io/docs/6.6/transactions#pessimistic-locking) e [PostgreSQL 17 — row-level locks](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS). Evidências históricas do ticket 13: [resolução de referências](docs/verification.md#resolução-de-referências--2026-10-23).


## Consultas e paginação

Wallet é lida por ID e reidratada. Ledger verifica existência da wallet e lê por `(created_at, id)` crescente. Cursor base64url canônico aponta para lançamento persistido da mesma wallet; PostgreSQL compara timestamp integral, sem passagem por `Date` para retomar página. Resposta preserva timestamp textual com offset e precisão disponível.

Keyset evita deslocamento de linhas existentes, sem manter um snapshot entre consultas. Linhas novas posteriores à âncora podem aparecer; inserções retroativas anteriores exigem nova travessia. O cursor é opaco, mas não é secreto nem funciona como credencial ou mecanismo de autorização. Contrato detalhado e exemplos: [Postman](docs/postman/README.md).

### Consulta de transação

Ambas as rotas GET usam `WageringService.get`: um EntityManager novo faz um SELECT por ID interno ou pelo par completo `(providerId, externalTransactionId)`. O índice único existente atende à identidade externa. Nenhum lock financeiro, flush, processamento ou evento é necessário; nenhuma migration foi adicionada.

A projeção explícita preserva identidade, valor/moeda, status, datas e `failureCode` quando presente. Saldo vem de `observedBalance`, não da wallet atual; chave de idempotência e hash não são expostos. UUID aceita maiúsculas e é normalizado; identificadores externos preservam caixa e regras da submissão: até 200 caracteres, sem controles ou espaços nas extremidades, provider `internal` reservado. Identidade ausente retorna `TRANSACTION_NOT_FOUND`; inválida falha antes de consultar.

Consulta de rejeição retorna 200 com resultado persistido; 422 pertence à tentativa de processamento. Não há `idempotentReplay` em leitura. OPENING é acessível por ID interno, com metadados externos nulos e sem `balance` quando não há saldo observado persistido. Não são inventados dados de provedor ou saldo histórico.

Alternativa descartada: reconstruir resultado pelo ledger, que não contém lançamentos de rejeições. Ler diretamente a transação também preserva o saldo original após outras apostas e reinício, sem cache local. A leitura vê somente registros confirmados; um 404 não prova que uma submissão concorrente nunca fará commit.

Referência: [NestJS controllers](https://docs.nestjs.com/controllers), consultada via Context7 para `@Get`, `@Param` e status 200; compatibilidade exercitada no NestJS 11.1.16. Evidências: [consulta de transação](docs/verification.md#consulta-de-transação--2026-10-23).

## Reconciliação

Decisão adotada no ticket 04 (§9): um único SELECT parametrizado lê wallet e soma assinada de todo ledger via agregação lateral. CREDIT soma, DEBIT subtrai; histórico vazio vale `0.00`. `numeric` preserva escala e precisão; soma não é limitada novamente a numeric(30,2). Strings monetárias nunca passam por `number`. `difference = storedBalance - calculatedBalance`, podendo ser negativa; `checkedEntries` conta lançamentos, não transações.

O snapshot de comando em READ COMMITTED vê saldo e ledger no mesmo instante, sem bloquear escritor. Uma movimentação atômica concorrente aparece inteira ou não aparece. Alternativa: duas leituras em REPEATABLE READ; descartada por adicionar transação sem benefício para uma única consulta. Duas leituras em READ COMMITTED seriam incorretas. Resultado é diagnóstico daquele instante, não reserva nem garantia sobre escrita posterior.

Nenhuma correção automática, mudança de versão ou escrita financeira. Cada divergência emite mensagem JSON `WalletReconciliationDivergence` via Logger Nest, apenas com walletId, sem saldos, player ou payload; envelope de saída segue logger configurado. Incrementa contador Prometheus sem labels, exposto em GET /metrics no mesmo módulo. Contador por processo, cumulativo por chamada, não persistente e não usado como garantia financeira; coletor deve agregar instâncias e tratar resets. Observabilidade global do §12 permanece pendente.

Teste HTTP com PostgreSQL real cobre zero, abertura além de Number.MAX_SAFE_INTEGER, duas direções de diferença, ausência de reparo, log, contador e transação concorrente parada entre alteração de saldo e inclusão de ledger. Fixture crédito/débito é sintética e isolada, não implementação de BET. Evidências: [verificação](docs/verification.md#reconciliação--2026-10-22).

Referência consultada via Context7: [PostgreSQL 17 — READ COMMITTED](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED), snapshot por comando.


## Falhas HTTP

| Status | Códigos / comportamento |
|---|---|
| 400 | `INVALID_WALLET_PAYLOAD`, `INVALID_IDENTITY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INITIAL_BALANCE_NEGATIVE`, `INVALID_LEDGER_QUERY`; transações externas: `INVALID_TRANSACTION_PAYLOAD`, `INVALID_TRANSACTION_KIND`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_PROVIDER`, `PLAYER_WALLET_MISMATCH`, `CURRENCY_MISMATCH` |
| 404 | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| 409 | `WALLET_ALREADY_EXISTS`, `TRANSACTION_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT` |
| 422 | BET/WIN/REFUND/ROLLBACK persistida REJECTED com failureCode, transactionId e saldo observado; `INSUFFICIENT_FUNDS` para BET, `REFERENCE_MISMATCH`, `REFERENCE_NOT_PROCESSED` ou `REFERENCE_NOT_FOUND` para referências, `REFERENCE_ALREADY_REFUNDED` para REFUND, `REFERENCE_ALREADY_ROLLED_BACK` ou `INSUFFICIENT_REVERSAL_FUNDS` para ROLLBACK; replay mantém resultado |
| 202 | WIN/REFUND/ROLLBACK PENDING_REFERENCE persistida, sem movimento; replay também retorna 202 |
| 503 | Transações externas: `TEMPORARY_UNAVAILABLE` para códigos conhecidos de conexão, shutdown, serialização, deadlock ou timeout/indisponibilidade de lock; sem retry automático |
| 500 | Falha inesperada: resposta genérica do NestJS, sem SQL/credenciais |

Erros conhecidos retornam `{ "code": "..." }`, exceto a rejeição 422, que retorna o resultado financeiro auditado. Transação externa processada retorna 201, inclusive no replay. DTO rejeita campos extras, estruturas inválidas e dinheiro não textual, sem conversão implícita; falha estrutural precede formato. JSON malformado na submissão recebe `INVALID_TRANSACTION_PAYLOAD`. Falhas inesperadas não viram 400/409. WIN/REFUND/ROLLBACK com referência indisponível retorna 202 persistido; BET e LOSS são síncronas e nunca retornam 202. Kind desconhecido retorna 400. Após 503 ou perda da resposta, reenviar mesma chave/payload permite descobrir commit já ocorrido; não trocar chave. Erros 400 corrigem contrato; 409 exige resolver identidade/payload; 422 é resultado terminal, não retry para tentar obter outro saldo.

## Decisões

[DECISIONS](DECISIONS.md) relaciona as decisões aos requisitos. As decisões D-001 a D-005 estão registradas nos ADRs 0001 a 0005, com os mesmos status e limites. O [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) registra a organização modular adotada. Os ADRs reúnem justificativas, alternativas e consequências.

## Ainda não entregue

Inbox/consumidor SQS, retry/DLQ de entrada, health e observabilidade dos demais fluxos permanecem em [PROGRESS](PROGRESS.md). Resolução de referências e publicação de outbox têm workers separados. Próximo ticket: 18, BET pela fila com inbox.

API é local e sem autenticação. Decisão final de omissão/IdP e ponto de extensão exigidos pelo enunciado ainda pendentes; bind em loopback não os substitui. Shutdown atual espera os workers de resolução e publicação, fecha HTTP e ORM; não há consumer, ack ou tratamento de visibilidade.

Setup, migrations e riscos de reversão: [README](README.md). Resultados executados e limites das provas: [evidências](docs/verification.md).

## Referências consultadas

- [MikroORM 6.6 EntitySchema](https://mikro-orm.io/docs/6.6/entity-schema): mapeamento sem decorators no domínio.
- [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations): execução programática e reversão.
- [NestJS controllers](https://docs.nestjs.com/controllers): rotas, serialização e códigos padrão 201/200; implementação usa APIs presentes em 11.1.16.
- [Bun/NestJS metadata](https://github.com/oven-sh/bun/blob/main/test/integration/nest/nest_metadata.test.ts): suporte a decorators; compatibilidade com Bun 1.3.14 comprovada executando HTTP real, não inferida do branch main.
- [MikroORM 6.6 transações](https://mikro-orm.io/docs/6.6/transactions): transação explícita inclui Unit of Work e SQL customizado; flush interno não antecipa commit externo.
- [PostgreSQL 17 constraints](https://www.postgresql.org/docs/17/ddl-constraints.html): CHECK para aritmética local, UNIQUE e FKs para relações.
- [PostgreSQL 17 trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html): exceção aborta UPDATE/DELETE/TRUNCATE de auditoria.
- [NestJS validation](https://docs.nestjs.com/techniques/validation): DTOs, whitelist, `exceptionFactory` e rejeição de campos extras; APIs verificadas com NestJS 11.1.16.
- [NestJS exception filters](https://docs.nestjs.com/exception-filters): filtro centralizado com `BaseExceptionFilter` preserva tratamento genérico de falhas inesperadas.
- [Bun Docker](https://bun.sh/guides/ecosystem/docker): imagem oficial, instalação com lockfile e execução do código-fonte; projeto fixa versão em vez da tag genérica do exemplo.
- [MikroORM 6.6 Unit of Work](https://mikro-orm.io/docs/6.6/unit-of-work): persistência e flush não substituem fronteira transacional.
- [NestJS validation](https://docs.nestjs.com/techniques/validation): consulta via Context7 para `ValidationPipe`, whitelist e `exceptionFactory`; compatibilidade comprovada no NestJS 11.1.16 por HTTP real. Nest Boost MCP inspecionou rotas e DI existentes e confirmou nova rota em processo novo; servidor persistente anterior manteve snapshot antigo.
- [NestJS modules](https://docs.nestjs.com/modules) e [dynamic modules](https://docs.nestjs.com/fundamentals/dynamic-modules): imports/exports explícitos e metadata dinâmica que estende, não substitui, metadata estática; consulta via Context7 orientou a composição, sem duplicar imports estáticos/dinâmicos da funcionalidade.