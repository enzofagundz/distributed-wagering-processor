# 7. Inbox atômica de BET

## Status

Aceita. Ticket 18, seções 10 e 11 do enunciado.

## Contexto

O SQS pode entregar a mesma mensagem depois de um commit cujo ack não chegou ao broker. A deduplicação FIFO tem janela própria e não substitui a idempotência persistente. Uma mensagem também pode reutilizar o ID de outra com conteúdo diferente.

## Decisão

`WagerConsumer`, registrado em `WageringModule`, recebe BET, WIN, LOSS, REFUND e ROLLBACK de `wager-transactions.fifo`. O parser exige o envelope `WagerTransactionRequested`, identidade não vazia de até 200 caracteres, data UTC no formato `YYYY-MM-DDTHH:mm:ss.sssZ`, `data.idempotencyKey` e DTO financeiro compartilhado com HTTP. Campos extras e dinheiro numérico são inválidos. `WagerTransaction.create` continua validando provider, identidade, valor positivo e kind; `internal` e OPENING são proibidos. Identidade de domínio não autentica remetente: o broker local continua sendo um canal confiável sem IdP.

O consumidor chama `WageringService.submit`, o mesmo caso de uso HTTP, com contexto opcional de inbox. A transação SQL reserva `(consumer_name = 'wager-transactions', message_id)` por `INSERT ON CONFLICT DO NOTHING RETURNING`. Esse comando espera a resolução de uma reserva concorrente da mesma identidade; se o concorrente abortar, a nova tentativa pode reservar. Não há lock global nem chamada ao SQS dentro dessa transação. Escritas financeiras mantêm os registros MikroORM existentes; SQL parametrizado da inbox controla a reserva concorrente e o checkpoint associado ao commit.

A inbox guarda SHA-256 do envelope inteiro, serializado recursivamente com chaves em ordem lexicográfica. Inclui `occurredAt`, tipo, chave de idempotência e dados; exclui atributos SQS e receipt handle. Mudar só a ordem das chaves não conflita. Esse hash de transporte é separado do hash de negócio existente, que continua excluindo a chave e metadados de transporte.

`InboxMessage.receive` valida identidade, hash e data em uma factory de domínio. `rehydrate` restaura checkpoints sem reaplicar o recebimento; `markProcessed` só aceita uma transição, com data finita posterior ou igual ao recebimento. Depois da reserva, o caso de uso aplica as regras financeiras e grava o resultado serializado e `processed_at` na inbox. Inbox, transação financeira, wallet, ledger e outbox confirmam juntos. Qualquer exceção antes do commit desfaz o conjunto. Uma inbox já confirmada com hash igual devolve o resultado original com `idempotentReplay: true`; hash divergente gera `MESSAGE_ID_CONFLICT`. Outro messageId passa pela idempotência financeira existente, registra sua própria inbox e não cria movimento nem evento adicional. Se uma corrida financeira violar unicidade, a transação perdedora aborta por inteiro; o replay e sua inbox são confirmados juntos em nova transação SQL.

O ack usa `DeleteMessage` com o receipt handle da entrega corrente, depois do retorno confirmado do caso de uso. Rejeição por saldo insuficiente é resultado terminal persistido, com evento e ack. Mensagem inválida, conflito de payload ou identidade incompatível seguem para `wager-transactions-dlq.fifo`; só depois do envio aceito o consumidor exclui a origem. Falha nesse envio ou no ack permite redelivery. Queda entre envio à DLQ e exclusão pode repetir a mensagem na DLQ; o corpo preserva a identidade original, e deduplicação FIFO usa hash do ID SQS e corpo.

Falhas `TEMPORARY_UNAVAILABLE` e falhas inesperadas usam `ApproximateReceiveCount`: após falhas 1–4, a visibilidade espera `min(2 ** count, 60)` segundos; a quinta falha vai à DLQ. `RedrivePolicy` também usa `maxReceiveCount = 5` como proteção do broker. Cada entrega recebe visibilidade de 30 segundos, renovada a cada dez segundos enquanto o caso de uso está em execução. Falha de renovação gera chamada ao Logger; uma entrega concorrente continua protegida pela inbox e pelas constraints financeiras. O bootstrap atual usa `logger: false`, portanto a emissão operacional desses logs permanece no ticket 25.

`SIGTERM` e `SIGINT` param o agendamento e esperam a mensagem em andamento, depois fecham aplicação e ORM. Não há prazo máximo de drenagem neste ticket. `SIGKILL` elimina o processo e as renovações; após a visibilidade expirar, outra instância retoma pelo estado persistido. O publisher de eventos continua separado e só lê commits.

Migration `20261023000800` cria PK composta, hash hexadecimal de 64 caracteres, datas finitas e vínculo entre resultado e checkpoint. Down remove a tabela apenas vazia: histórico de deduplicação não pode ser descartado silenciosamente. Pare os consumidores antes de reverter. Não há retenção automática da inbox.

## Consequências

A inbox ocupa espaço por identidade de mensagem, inclusive quando a operação é replay por outra identidade de transporte. O resultado original permanece disponível mesmo após novos movimentos. Ack perdido pode aumentar o contador de recebimentos sem representar falha financeira; uma mensagem pode chegar à DLQ com resultado já confirmado. Antes de redrive, consulte a transação pela identidade externa.

A alternativa de confirmar inbox separadamente deixaria uma janela com deduplicação sem débito, ou débito sem deduplicação. Usar apenas a chave de negócio impediria débito duplicado, mas não detectaria reutilização divergente de messageId. Usar apenas FIFO deixaria a garantia limitada ao broker.

Interrupção real de dependência, FAILED auditável, prazo limitado de shutdown e métricas globais continuam nos tickets 21–27. A classe de domínio InboxMessage é independente de NestJS e ORM; a modelagem equivalente de OutboxMessage continua pendente na cobertura.

Documentação consultada via Context7: [AWS SDK v3 — comandos SQS](https://github.com/aws/aws-sdk-js-v3/tree/main/clients/client-sqs), exercitados com 3.1156.0; [MikroORM — transações](https://mikro-orm.io/docs/6.6/transactions), exercitadas com 6.6.8. Resultados e limites: [verificação](../verification.md#bet-por-sqs--2026-10-23).

## Extensão no ticket 19

O parser libera WIN e LOSS no mesmo consumidor. Contratos, validação, taxonomia de falhas e processamento continuam em `submitTransactionValidation` e `WageringService.submit`. Não há migration nem segundo caminho financeiro. WIN confirma crédito, CREDIT e eventos Processed/BalanceChanged; LOSS confirma resultado e Processed sem alterar saldo, versão, data da wallet ou ledger. Referência opcional de WIN mantém pendência, resolução agendada e rejeições do HTTP. Pendência e rejeição de negócio recebem ack após commit; payload inválido e conflito continuam na DLQ.

Inbox e idempotência de negócio preservam o resultado original em reenvios, inclusive após outra operação e reinício do consumidor. A alternativa de tratar os resultados diretamente no consumer duplicaria as regras financeiras e sua coordenação transacional. A extensão seguinte libera REFUND e ROLLBACK. [Evidências do ticket 19](../verification.md#resultados-por-sqs--2026-10-24).

## Extensão no ticket 20

SQS aceita REFUND e ROLLBACK pelo mesmo DTO e caso de uso HTTP. A lista restrita do parser foi removida: `externalWagerKinds`, usada pelo DTO, define o contrato externo; OPENING continua inválido. Não há migration nem regra financeira nova.

Reversão sem referência processável confirma pendência, inbox e `WagerTransactionPendingReference` na mesma transação. O consumidor recebe o resultado confirmado e envia ack. `PendingReferenceWorker` procura as linhas vencidas no PostgreSQL; seu progresso não depende da mensagem original. Contador, backoff e limite de dez tentativas seguem a política existente. Resolução ou rejeição terminal, com ledger quando aplicável e outbox, confirmam juntos sob lock da wallet. O publisher separado envia os eventos depois do commit.

A inbox é o recibo do aceite original. Redelivery do mesmo envelope preserva esse resultado mesmo após a transação sair de pendência; GET consulta o estado atual. Novo messageId com a mesma chave/payload passa pela idempotência de negócio e observa o resultado financeiro persistido. Nenhum dos replays reabre estado terminal nem repete evento ou lançamento.

Manter a mensagem invisível até chegar a referência prenderia a continuidade ao transporte e ocuparia o grupo FIFO. Persistir e dar ack permite seguir a agenda do banco após reinício, inclusive quando a referência nunca chega. Falha antes do commit desfaz também inbox e pendência; falha depois do commit e antes do ack resulta em replay seguro.

Documentação oficial consultada via Context7: [AWS SDK v3 SQS Message](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-sqs/src/models/models_0.ts), receipt handle corrente por entrega; compatibilidade exercitada com SDK 3.1156.0. [Evidências e limites](../verification.md#reversões-por-sqs--2026-10-24).
