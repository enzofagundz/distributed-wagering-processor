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

Interrupção real de dependência, FAILED auditável e prazo limitado de shutdown chegaram nos tickets 21–27. A classe de domínio InboxMessage é independente de NestJS e ORM; a modelagem equivalente de OutboxMessage foi entregue no ticket 02 de `fechar-lacunas-obrigatorias`.

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

## Extensão no ticket 21

Sem mudança de produção. A política de retry descrita acima já separa falhas terminais de transitórias. Rejeição de negócio persistida recebe ack. Payload inválido, conflito de messageId e identidade incompatível vão à DLQ. Erros de conexão do driver (ECONNREFUSED, ECONNRESET, ETIMEDOUT e similares) e SQLSTATE das classes 08, 40, 53, 55 e 57 viram `TEMPORARY_UNAVAILABLE`; falha inesperada segue o mesmo caminho. Nesses casos não há ack: a visibilidade passa para `min(2 ** count, 60)` segundos, e a quinta falha envia à DLQ.

Como a queda ocorre antes do commit, inbox, transação, ledger e outbox não existem quando a mensagem volta. A entrega seguinte executa a transação inteira uma única vez. Se o banco cair depois do commit e antes do ack, o reenvio encontra a inbox e devolve o resultado original.

Alternativa descartada: depender só da `RedrivePolicy` com visibilidade fixa. O retry ficaria com intervalo constante e sem registro da causa no consumidor. Limite: cinco tentativas com backoff somam cerca de 30 segundos; uma queda mais longa leva a mensagem à DLQ, e o redrive manual deve começar pela consulta da transação. [Evidências](../verification.md#falhas-transitórias-do-consumidor--2026-10-24).

## Extensão no ticket 22

A mensagem enviada à DLQ mantém o corpo original e leva a causa em atributos SQS: `failureCode`, `failureKind` (`PERMANENT` ou `RETRIES_EXHAUSTED`), `receiveCount`, `sourceMessageId` (ID SQS da entrega) e `wagerMessageId`, quando o envelope foi lido. Assim o operador sabe por que a mensagem parou ali sem abrir log, e o hash usado na inbox não muda num redrive.

Saldo insuficiente não vai à DLQ. É rejeição de negócio: grava REJECTED/INSUFFICIENT_FUNDS, inbox e `WagerTransactionRejected` na mesma transação e recebe ack. A DLQ fica para falha técnica ou mensagem que nunca vai processar.

Não criamos status FAILED neste consumidor. As falhas que chegam à DLQ acontecem antes de existir transação (envelope inválido, provider reservado, identidade incompatível), contra uma transação que já tem resultado (conflito de messageId) ou depois de rollback completo (tentativas esgotadas). Em nenhum desses casos há linha de transação para marcar. O estado `FAILED` existe apenas na resolução de referências pendentes, conforme a [arquitetura](../../ARCHITECTURE.md#falha-permanente-de-infraestrutura).

Redrive: consultar antes a transação por provider e ID externo. Se já houver resultado, descartar a mensagem; senão, reenviar o corpo sem alteração à fila de entrada com novo `MessageDeduplicationId`. [Evidências](../verification.md#dlq-do-consumidor--2026-10-24).

## Extensão no ticket 23

O shutdown passou a ter prazo. `stop()` interrompe novas leituras e espera a mensagem em andamento por até `WAGER_SHUTDOWN_DRAIN_MS` (padrão 20000 ms). Se ela terminar a tempo, o comportamento é o de antes: commit, ack e só então fecha ORM e cliente SQS.

Se o prazo vencer antes do ack, o consumidor para a renovação de visibilidade, devolve a mensagem com `VisibilityTimeout = 0` e registra `WagerShutdownDeadline`. O processo segue fechando. Há dois casos. Commit já feito: outra instância recebe a mensagem e a inbox devolve o resultado original, sem novo débito. Transação ainda aberta: fechar a conexão faz o PostgreSQL desfazer tudo, e a reentrega processa do zero. Nenhum dos dois depende de memória local. O publisher só lê o que foi commitado.

Por que devolver em vez de só esperar a visibilidade expirar: sem a devolução, a mensagem fica parada até 30 s depois do último heartbeat. Com ela, a próxima instância pega na hora. A chamada é best-effort; se falhar, vale a expiração normal.

`orm.close()` espera conexões ativas, então uma transação travada seguraria o processo depois da devolução. Por isso `main.ts` força a saída com código 1 dez segundos após o prazo do consumidor; o PostgreSQL desfaz a transação aberta quando a conexão cai. Limite: workers de referência e outbox continuam esperando sem prazo próprio, cobertos só por essa saída forçada. Morte forçada (SIGKILL) continua coberta pela visibilidade, como no ticket 18. [Evidências](../verification.md#shutdown-do-consumidor--2026-10-24).
