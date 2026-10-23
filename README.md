# Distributed Wagering Processor

Serviço financeiro desenvolvido em etapas para o [desafio técnico](README_TECHNICAL_CHALLENGE.md), com Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL.

A API permite abrir wallet, consultar saldo, paginar ledger, reconciliar sem reparar dados e processar BET, WIN, LOSS, REFUND e ROLLBACK por HTTP. Transações podem ser consultadas por ID interno ou identidade do provedor. Abertura positiva e operações financeiras persistem saldo, transação, ledger e eventos pendentes na mesma transação SQL. LOSS confirma resultado e evento sem movimentar saldo. Um worker agendado resolve WIN, REFUND e ROLLBACK que chegaram antes da referência.

O publisher envia eventos confirmados da outbox ao SQS no LocalStack. Entrada por SQS/inbox, autenticação e health estão pendentes. A referência ausente fica persistida como `PENDING_REFERENCE`, sem movimento; o worker aplica backoff persistido e encerra a pendência após dez tentativas sem resolução. Métrica e log específicos de reconciliação estão disponíveis; observabilidade dos demais fluxos continua pendente. A [cobertura por requisito](PROGRESS.md) lista o que falta para concluir o desafio.

## Roteiro para leitura e avaliação

1. Execute API e migrations abaixo.
2. Importe [collection e environment Postman](docs/postman/README.md); percorra abertura, ledger, BET, replay, consultas e reconciliação. O guia inclui disputa manual entre três instâncias. Não exige conta ou publicação em workspace.
3. Leia [arquitetura e garantias atuais](ARCHITECTURE.md), [glossário](GLOSSARY.md) e decisões vinculadas.
4. Consulte [evidências executadas](docs/verification.md) e [pendências por requisito](PROGRESS.md). Resultados históricos não substituem execução local.

Wallets ficam em `src/wallets/`; submissão de BET, WIN, LOSS, REFUND e ROLLBACK, em `src/wagering/`. Cada funcionalidade tem controller, DTO, serviço e módulo. `src/app.module.ts` compõe módulos e registra filtro global compartilhado; `src/create-application.ts` recebe o ORM inicializado pelo chamador. Domínio e mapeamentos permanecem separados. Justificativa e injeção de dependências: [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) e [composição na arquitetura](ARCHITECTURE.md#composição-e-injeção).

## Executar

Requisitos: Docker com Compose v2+. Para desenvolvimento/testes no host: Bun 1.3.14. Portas locais: HTTP 3000, PostgreSQL 55432, banco descartável de testes 55433 e LocalStack 4566.

### Containers

```sh
docker compose build app
docker compose up -d --wait postgres localstack
docker compose run --rm app bun run migration:up
docker compose up -d app
docker compose logs app
```

Espere `Wallet HTTP listening` antes de chamar a API, pois o startup ainda não tem health check HTTP. A imagem usa Bun 1.3.14 e dependências de produção com lockfile congelado; este modo dispensa Bun no host. Execute as migrations explicitamente: o startup nunca as executa.

Se a porta estiver ocupada, use `APP_PORT=3109 docker compose up -d app` e ajuste `baseUrl` no Postman para `http://127.0.0.1:3109`. Na rede Compose, a API conecta a `postgres:5432`, não a localhost. Podman rootless com Docker Compose como provider também foi verificado em Linux. Para usá-lo, inicie `systemctl --user start podman.socket` e substitua `docker compose` por `podman compose`.

### Host

```sh
bun install --frozen-lockfile
test -f .env || cp .env.example .env
docker compose up -d --wait postgres postgres-test localstack
bun run migration:up
bun run start
```

Bun lê `.env` automaticamente ao iniciar a aplicação, executar migrations ou rodar testes. O comando de cópia preserva um `.env` existente; nesse caso, complete as chaves que faltam. As URLs separam desenvolvimento (`55432/wagering`) de testes (`55433/wagering_test`). `HOST` e `PORT` definem onde a API escuta.

O Git ignora `.env` e suas variantes locais. Somente `.env.example` entra no repositório, com valores para o Compose local.

Variáveis exportadas no terminal têm prioridade sobre `.env`. Se uma configuração antiga persistir, remova o export ou abra um terminal sem essa variável. Para rodar três APIs com o mesmo `.env`, mude apenas a porta: `PORT=3101 bun run start`, `PORT=3102 bun run start` e `PORT=3103 bun run start`, cada comando em um terminal.

No container da API, o Compose define `DATABASE_URL`, `HOST` e `PORT`: banco em `postgres:5432` e bind em `0.0.0.0`. Essas configurações não vêm do `.env` do host, e a imagem exclui arquivos `.env`. Para mudar a porta publicada pelo Compose, defina `APP_PORT` no `.env` local.

**Ambiente exclusivamente local, sem autenticação. Não expor em produção.** Credenciais do Compose são locais. Publicação HTTP fica em loopback; bind interno do container é `0.0.0.0`. No host, bind padrão é `127.0.0.1`.

## Publicar e inspecionar eventos

O Compose inicia LocalStack 4.11.1 e cria a fila standard `wagering-events` pelo hook `infra/localstack/init-sqs.sh`. O health check só passa quando a fila existe. A fila é de saída; ainda não há consumidor de operações. O estado do broker é descartável: recriar o container apaga mensagens, inclusive eventos que o PostgreSQL já marcou como publicados.

No host, complete as chaves SQS de `.env.example` no seu `.env` existente. Use região `us-east-1`, credenciais locais `test`/`test`, `SQS_ENDPOINT=http://127.0.0.1:4566` e `OUTBOX_QUEUE_URL=http://127.0.0.1:4566/queue/us-east-1/000000000000/wagering-events`. No container da API, o Compose troca o host por `localstack`.

`bun run start` inicia o publisher junto da API. A cada segundo, ele envia até 100 eventos, um por transação SQL. Depois de criar uma wallet positiva e submeter a BET abaixo, inspecione os eventos:

```sh
docker compose exec localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/queue/us-east-1/000000000000/wagering-events \
  --max-number-of-messages 10 --wait-time-seconds 2
docker compose exec postgres psql -U wagering -d wagering \
  -c 'select id, event_type, attempts, next_attempt_at, published_at from outbox_messages order by occurred_at desc limit 10'
```

`receive-message` torna as mensagens temporariamente invisíveis; sem `delete-message`, elas voltam após o visibility timeout. Uma abertura positiva e uma BET processada produzem quatro eventos no total; uma BET rejeitada produz somente `WagerTransactionRejected`. Cada corpo preserva o envelope persistido, com `eventId`, `eventType`, `aggregateId`, `correlationId`, `occurredAt`, `version` e `data`; `causationId` é opcional e os produtores atuais o omitem. Valores monetários usam `{amount, currency}`, com duas casas em string.

Se o envio falhar, `published_at` continua nulo; `attempts` e `next_attempt_at` persistem no PostgreSQL. O retry espera 2s, 4s, 8s e dobra até o teto de 300s, sem limite de falhas ou descarte. Reiniciar a API preserva o prazo. Execute `bun run migration:up` antes de iniciar o publisher atualizado. Queda após envio e antes da marcação pode duplicar o mesmo `eventId`; consumidores precisam deduplicá-lo. Decisão e limites: [publicação da outbox](ARCHITECTURE.md#publicação-da-outbox).

Teste focal: `bun test tests/integration/outbox.test.ts`. Ele exige `TEST_DATABASE_URL` terminado em `_test` e LocalStack em `TEST_SQS_ENDPOINT` (padrão `http://127.0.0.1:4566`). Cria schema e fila exclusivos, verifica HTTP → SQS, rejeição, falha de rede, retomada após SIGKILL, backoff e rollback financeiro; remove esses recursos no fim. Também executa dois publishers em processos distintos, pausa ambos após envios aceitos pelo SQS, mata um deles antes da marcação e verifica recuperação com deduplicação persistente por `eventId`.

Para repetir somente a prova de concorrência e crash, com os serviços locais disponíveis:

```sh
docker compose up -d --wait postgres-test localstack
TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test \
  bun test tests/integration/outbox.test.ts --test-name-pattern 'two publishers'
```

A fixture pausa o retorno do SDK após a resposta real de `SendMessage`; não substitui PostgreSQL nem SQS. O teste observa dois locks simultâneos, progresso do worker vivo e recuperação após SIGKILL. No cenário sem novas falhas, quatro eventos geram cinco entregas, quatro efeitos deduplicados e nenhuma pendência. Isso não limita quantas duplicatas um SQS standard pode entregar ou quantos reenvios novas quedas podem causar. O consumidor de verificação existe apenas no teste; inbox de produção continua pendente.

Para experimentar a retomada no Compose sem apagar mensagens, execute `docker compose pause localstack`, submeta uma BET e consulte a outbox com o comando acima. Após a falha, `attempts` aumenta e `next_attempt_at` recebe um prazo. Execute `docker compose restart app` e `docker compose unpause localstack`; depois do prazo e da próxima varredura, confira `published_at` e receba os eventos. Use sempre `unpause` ao terminar. Este roteiro interrompe o broker compartilhado do ambiente local.

## Experimentar HTTP

```sh
curl -i http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
curl -i http://127.0.0.1:3000/wallets/ID_RETORNADO
curl -i 'http://127.0.0.1:3000/wallets/ID_RETORNADO/ledger?limit=50'
curl -i -X POST http://127.0.0.1:3000/wallets/ID_RETORNADO/reconciliation
curl -i http://127.0.0.1:3000/metrics
```

Dinheiro entra e sai como string decimal com duas casas. Abertura retorna 201; consultas, 200; reenvio de abertura para mesmo player/moeda retorna 409, não replay. Saldo zero não gera lançamento. Contratos, exemplos de resposta, erros e paginação: [guia Postman](docs/postman/README.md).

Reconciliação retorna 200 com `walletId`, `storedBalance`, `calculatedBalance`, `difference` (armazenado menos calculado, inclusive negativo), `consistent` e `checkedEntries`. Valores monetários seguem `{amount, currency}`. Wallet ausente retorna 404; UUID inválido, 400. A soma inclui OPENING e débitos/créditos no mesmo snapshot SQL. Não altera saldo, versão ou ledger. `GET /metrics` expõe contador Prometheus `wallet_reconciliation_divergences_total`, sem labels de wallet; soma por instância, reinicia com processo. Cada chamada divergente incrementa contador, inclusive reenvios. Detalhes: [arquitetura](ARCHITECTURE.md#reconciliação).

### Submeter BET

Use player e wallet retornados pela abertura. O exemplo aposta `80.00 BRL`; numa wallet de `100.00 BRL`, retorna 201 com `PROCESSED`, saldo `20.00 BRL` e `idempotentReplay: false`.

```sh
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-001","playerId":"PLAYER_RETORNADO","walletId":"ID_RETORNADO","roundId":"round-001","gameId":"fortune-chimp","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

Envie outra aposta de `80.00` com nova chave e novo `externalTransactionId`: retorna 422 com `REJECTED`, `failureCode: "INSUFFICIENT_FUNDS"` e saldo `20.00`. Rejeição fica auditada, sem ledger nem incremento de versão. Header obrigatório; BET, WIN, LOSS, REFUND e ROLLBACK são os kinds externos aceitos. Identificadores textuais têm até 200 caracteres; valor deve ser positivo e caber em `numeric(30,2)`.

Reenvie exatamente a primeira BET com a mesma chave: retorna 201, identidade e saldo originais, com `idempotentReplay: true`, mesmo após outras apostas ou reinício. Payload diferente com a mesma chave retorna 409 `IDEMPOTENCY_CONFLICT`. Outra chave com o mesmo par provider/external ID retorna 409 `TRANSACTION_ALREADY_EXISTS`. Nenhum desses reenvios gera novo débito ou evento. Chave tem escopo global; identidade externa tem escopo por provider. Hash, precedência dos conflitos e política HTTP: [idempotência de BET](ARCHITECTURE.md#idempotência-de-bet).

### Creditar WIN

Use a mesma wallet e rodada da BET acima. O prêmio pode ter valor diferente da aposta:

```sh
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:win-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"win-001","playerId":"PLAYER_RETORNADO","walletId":"ID_RETORNADO","roundId":"round-001","gameId":"fortune-chimp","kind":"WIN","money":{"amount":"150.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'
```

Após a BET de `80.00` sobre `100.00`, esse WIN retorna 201 com saldo `170.00 BRL`. Confirma um CREDIT e dois eventos na outbox; a versão aumenta uma vez. Reenvio com mesma chave e payload retorna o saldo original, sem novo crédito. Alterar a referência com a mesma chave é conflito 409.

Omitir `referenceExternalTransactionId` permite prêmio independente. Quando informada, a referência usa o ID externo da BET no mesmo provider e deve coincidir em player, wallet, moeda e rodada; valor do prêmio e jogo não precisam coincidir. Incompatibilidade retorna 422 `REFERENCE_MISMATCH`; BET rejeitada retorna 422 `REFERENCE_NOT_PROCESSED`. Nenhuma rejeição move saldo ou cria ledger.

Referência informada ainda inexistente ou não terminal retorna 202 `PENDING_REFERENCE`, sem crédito. Reenvio mantém a pendência e devolve o saldo observado no aceite; quem resolve é o worker agendado, não o replay. Quando a BET chega, uma tentativa vencida do worker pode creditá-la uma vez e gravar os eventos Processed/BalanceChanged. Referência ausente ou ainda pendente na décima tentativa encerra o WIN com `REFERENCE_NOT_FOUND`. Decisão e limites: [resolução de referências](ARCHITECTURE.md#resolução-de-referências-pendentes).

Teste focal com PostgreSQL de testes iniciado: `bun test tests/integration/win-http.test.ts`.

### Registrar LOSS

Use nova identidade externa e nova chave, mantendo player e wallet da abertura:

```sh
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:loss-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"loss-001","playerId":"PLAYER_RETORNADO","walletId":"ID_RETORNADO","roundId":"round-001","gameId":"fortune-chimp","kind":"LOSS","money":{"amount":"80.00","currency":"BRL"}}'
```

Retorna 201 com `PROCESSED` e saldo atual, sem alterar saldo, versão ou ledger. Persiste apenas o resultado e `WagerTransactionProcessed` na outbox. Valor positivo descreve a operação; não é novo débito e não exige saldo disponível. LOSS não aceita referência. Reenvio com mesma chave/payload devolve saldo observado original, mesmo após outras operações ou reinício; payload divergente retorna 409.

Setup permanece o mesmo; aplique `bun run migration:up` antes de iniciar a API. Testes focais: `bun test tests/domain/wager-transaction.test.ts` e `bun test tests/integration/loss-http.test.ts`. Decisão: [LOSS sem movimento](ARCHITECTURE.md#loss-sem-movimento).

### Devolver BET com REFUND

Após a BET de `80.00` sobre `100.00`, sem executar o WIN do exemplo:

```sh
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:refund-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"refund-001","playerId":"PLAYER_RETORNADO","walletId":"ID_RETORNADO","roundId":"round-001","gameId":"fortune-chimp","kind":"REFUND","money":{"amount":"80.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'
```

Retorna 201 com saldo `100.00 BRL`, um CREDIT e eventos Processed/BalanceChanged. Referência externa é obrigatória: somente BET PROCESSED do mesmo provider, player, wallet, moeda e rodada, com valor igual. Jogo pode diferir. Valor ou identidade incompatível retorna 422 `REFERENCE_MISMATCH`; BET rejeitada, `REFERENCE_NOT_PROCESSED`. Segunda devolução com nova identidade retorna 422 `REFERENCE_ALREADY_REFUNDED`, auditada sem crédito.

Referência ausente retorna 202 `PENDING_REFERENCE`, sem mudar saldo ou ledger. Reenvio com mesma chave/payload preserva resultado e saldo originais, inclusive pendência; não tenta resolver a referência. O worker agendado consulta a pendência de novo e aplica um único crédito quando a BET existir como PROCESSED. Omissão do campo obrigatório retorna 400 `INVALID_TRANSACTION_PAYLOAD`; referência integra o hash de idempotência.

Aplique `bun run migration:up` antes do startup. Testes com PostgreSQL real: `bun test tests/integration/refund.test.ts tests/integration/refund-schema.test.ts`; regras de domínio: `bun test tests/domain/wager-transaction.test.ts`. Decisão: [devolução de BET](ARCHITECTURE.md#devolução-de-bet-com-refund).

### Desfazer movimento com ROLLBACK

Após a BET de `80.00` sobre `100.00`, sem executar os outros exemplos:

```sh
curl -i http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:rollback-001' \
  -d '{"providerId":"provider-a","externalTransactionId":"rollback-001","playerId":"PLAYER_RETORNADO","walletId":"ID_RETORNADO","roundId":"round-001","gameId":"fortune-chimp","kind":"ROLLBACK","money":{"amount":"80.00","currency":"BRL"},"referenceExternalTransactionId":"bet-001"}'
```

Retorna 201 com saldo `100.00 BRL` e um CREDIT. ROLLBACK de WIN ou REFUND gera DEBIT do valor integral. Referência obrigatória deve estar PROCESSED, com mesmo provider, player, wallet, moeda e rodada. LOSS, OPENING e ROLLBACK não são referências elegíveis. Códigos de incompatibilidade e pendência seguem o contrato de REFUND.

Débito sem saldo retorna 422 `INSUFFICIENT_REVERSAL_FUNDS`, distinto de BET sem saldo. Segunda reversão ROLLBACK da mesma referência retorna 422 `REFERENCE_ALREADY_ROLLED_BACK`. Ambas ficam auditadas, sem movimento. REFUND e ROLLBACK da mesma BET podem coexistir: unicidade é por tipo, conforme §7.4. Replay preserva o resultado terminal depois da resolução; enquanto a pendência não for resolvida, retorna 202 com o saldo do aceite.

Aplique `bun run migration:up` antes do startup. Testes focais: `bun test tests/domain/rollback.test.ts tests/integration/rollback.test.ts tests/integration/rollback-schema.test.ts`. Decisão e limites: [ROLLBACK](ARCHITECTURE.md#reversão-de-movimento-com-rollback); resultados executados: [verificação](docs/verification.md#rollback-de-movimento--2026-10-23).

### Resolver referência pendente

`bun run start` inicia o worker junto com a API. A cada `PENDING_REFERENCE_INTERVAL_MS` (padrão `1000`), ele busca pendências cujo próximo horário de tentativa venceu, em páginas de `PENDING_REFERENCE_PAGE_SIZE` (padrão `100`), e tenta resolver cada uma em transação própria. Não existe rota administrativa para disparar a varredura.

Exemplo: envie um REFUND antes da BET. A resposta é 202 `PENDING_REFERENCE`, sem crédito. Se a BET chegar antes do encerramento, a próxima tentativa vencida aplica um único crédito e grava Processed/BalanceChanged. O replay passa a devolver 201 com `PROCESSED` e o saldo resultante; `GET` mostra o mesmo estado. Enquanto pendente, replay e `GET` preservam o saldo observado no aceite, mesmo que outra operação mude a wallet.

O primeiro retry fica imediatamente elegível. São no máximo dez tentativas do worker, além da submissão inicial, com backoff exponencial limitado a 60 segundos. Os nove delays somam 243 segundos desde o primeiro retry; isso não é TTL: downtime, duração da varredura e contenção podem alongar a espera. Reinício retoma contador e próximo horário persistidos. A [política na arquitetura](ARCHITECTURE.md#resolução-de-referências-pendentes) define cálculo, precedência e atomicidade.

Se a referência continuar ausente ou não terminal na décima tentativa, a operação termina `REJECTED` com `REFERENCE_NOT_FOUND`, sem ledger. Referência compatível `REJECTED` ou `FAILED` recebe `REFERENCE_NOT_PROCESSED`; `FAILED` está coberto no domínio, mas ainda não é persistido pelo schema. Replay da rejeição retorna 422 com o saldo observado no término, e GET retorna 200 com o mesmo resultado. `REFERENCE_NOT_FOUND` é definitivo: corrija a referência e use nova identidade externa/chave para uma nova operação. O replay nunca reabre nem credita a operação encerrada, mesmo que a referência chegue depois.

Para ajustar o intervalo e o lote:

```sh
PENDING_REFERENCE_INTERVAL_MS=250 PENDING_REFERENCE_PAGE_SIZE=50 bun run start
```

O worker para em `SIGTERM`/`SIGINT` depois de concluir a execução em andamento, antes de fechar o ORM. Várias instâncias podem rodar o worker: a linha da pendência é bloqueada no PostgreSQL com `SKIP LOCKED`, e só uma confirma a tentativa ou o resultado terminal. Falha SQL desfaz também o contador; a tentativa não é consumida.

Aplique `bun run migration:up` antes do startup. Testes focais com PostgreSQL de testes iniciado: `bun test tests/integration/pending-reference.test.ts tests/integration/reference-expiration-schema.test.ts`; domínio: `bun test tests/domain/wager-transaction.test.ts tests/domain/rollback.test.ts`. Tempo explícito em serviço/worker permite exercitar backoff e esgotamento sem esperar 243 segundos. Comandos executados, resultados e limites do ticket 14: [expiração de referências](docs/verification.md#expiração-de-referências--2026-10-23).

### Consultar transação

```sh
curl -i http://127.0.0.1:3000/wagering/transactions/TRANSACTION_ID_RETORNADO
curl -i http://127.0.0.1:3000/providers/provider-a/wagering/transactions/bet-001
```

As duas rotas retornam 200 com a mesma representação: `transactionId`, `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `status`, `balance`, `createdAt` e `processedAt`. WIN, REFUND e ROLLBACK incluem `referenceExternalTransactionId` quando informada e `referenceTransactionId` quando resolvida. Pendência tem `processedAt: null`. Rejeições incluem `failureCode`; consultá-las retorna 200, não o 422 da submissão. `balance` é o saldo observado na operação, não o atual. Consulta não processa operação nem retorna `idempotentReplay`, chave de idempotência ou hash.

UUID inválido retorna 400 `INVALID_IDENTITY`; provider inválido, 400 `INVALID_PROVIDER`; identidade externa inválida, 400 `INVALID_IDENTITY`. Identidade válida ausente retorna 404 `TRANSACTION_NOT_FOUND`. Provider e ID externo são sensíveis a maiúsculas; codifique cada segmento com percent-encoding quando necessário. OPENING pode ser consultada por ID interno, sem identidade de provedor nem saldo observado. Contrato e decisão: [arquitetura](ARCHITECTURE.md#consulta-de-transação).

Teste focal: `bun test tests/integration/transaction-query-http.test.ts`. Usa `TEST_DATABASE_URL` do `.env` e o mesmo setup PostgreSQL abaixo, sem nova migration.

## Verificação

```sh
test -f .env || cp .env.example .env
bun run lint
bun run format:check
bun run typecheck
bun run test:domain
docker compose up -d --wait postgres-test localstack
bun run test:integration
bun test
```

`bun run lint:fix` aplica correções automáticas do ESLint; `bun run format` formata arquivos com Prettier.

A integração exige PostgreSQL real e banco dedicado terminado em `_test`; os testes falham se esses requisitos não forem atendidos. Os testes aplicam migrations automaticamente. Fixtures de constraints usam rollback; testes HTTP positivos preservam auditoria append-only com identidades novas por execução.

Para verificar somente BET: `bun test tests/integration/bet-http.test.ts`. O arquivo cobre contrato, sucesso, rejeição, rollback induzido, replay, conflitos e reinício de aplicação/pool.

Para verificar a resolução e a expiração de referências: `bun test tests/integration/pending-reference.test.ts`. Usa o mesmo PostgreSQL de testes e não inicia o worker no bootstrap dos testes HTTP; os testes chamam serviço/worker com tempo explícito para controlar os retries.

### Concorrência entre processos

Com `postgres-test` iniciado e `TEST_DATABASE_URL` preenchida no `.env`:

```sh
bun test tests/integration/wallet-concurrency.test.ts
```

O teste inicia e encerra três processos Bun, cada um com aplicação Nest, porta HTTP dinâmica e pool próprio, no mesmo PostgreSQL real. Exercita HTTP e chamada direta ao mesmo `WageringService.submit`, obtido pelo container Nest. Não exige três containers da API nem portas fixas.

Cobre duas BET de `80.00` sobre `100.00`, replay de sucesso/rejeição nas três instâncias, 50 envios da mesma BET com um único débito e progresso de wallets distintas enquanto uma wallet fica bloqueada. A barreira consulta esperas reais no PostgreSQL, sem sleeps para supor concorrência. Todos os cenários conferem saldo materializado, reconstrução pelo ledger e quantidade/valor dos débitos.

Uma hot wallet serializa operações até commit/rollback; adicionar instâncias não paraleliza débitos dessa mesma wallet. O teste verifica isolamento entre wallets, não throughput ou latência sob carga. Método e limites: [arquitetura](ARCHITECTURE.md#concorrência-entre-processos); resultados executados: [verificação](docs/verification.md#concorrência-entre-processos--2026-10-23).

O teste `tests/integration/ledger-http.test.ts` cria e remove um banco exclusivo `ledger_<uuid>_test`; o usuário precisa de `CREATEDB`. A fixture remove a unicidade de OPENING por wallet somente nesse banco para montar um histórico sintético. Ela mantém as constraints do banco informado e não comprova movimentações de apostas.

`tests/integration/reconciliation-http.test.ts` também exige CREATEDB e remove banco exclusivo após execução. Histórico de crédito/débito é sintético: unicidade de OPENING é removida somente nesse banco; não comprova processamento de apostas.

### Reversão e parada

Execute somente no banco descartável. Os comandos abaixo sobrescrevem `DATABASE_URL` para não reverter o banco de desenvolvimento; ajuste o endereço se seu banco de testes for outro. Bun lê `.env`, mas o shell não recebe essas variáveis para expandir expressões como `$TEST_DATABASE_URL`.

```sh
DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun run migration:down
DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun run migration:up
```

Migration `20261022000400` preserva OPENING e adiciona BET; seu `down` recusa execução se houver BET persistida, sem apagar histórico. Migration `20261022000300` troca apenas índice. Reverter também `20261022000200` remove ledger, transações e outbox: exige backup antes e serviço parado. Reaplicar schema não recupera auditoria removida.

Migration `20261023000100` adiciona hash obrigatório para BET, preenche histórico existente e preserva OPENING sem hash. Seu `down` remove apenas hash e check; histórico financeiro permanece. Pare todas as APIs antes de migrar ou reverter; código antigo não grava o hash exigido pelo novo schema.

Migration `20261023000500` adiciona ROLLBACK e índice único parcial separado de REFUND. Seu `down` restaura o schema anterior somente sem histórico ROLLBACK, inclusive rejeições e pendências; com histórico, recusa sem apagá-lo. Pare APIs antes de migrar ou reverter.

Migration `20261023000600` adiciona contador de tentativas, próximo horário persistido e `REFERENCE_NOT_FOUND`; pendências anteriores ficam elegíveis a partir de `created_at`, com contador zero. Seu `down` recusa execução se houver rejeição por esgotamento, sem apagar histórico; caso contrário, remove a política persistida e restaura os checks anteriores. Pare todas as APIs antes de migrar ou reverter.

Migration `20261023000400` adiciona REFUND e índice único para devoluções processadas da mesma referência. `down` restaura BET/WIN/LOSS apenas sem histórico REFUND, inclusive pendências e rejeições; caso contrário, recusa sem apagar auditoria. Pare APIs antes de migrar ou reverter.

Migration `20261023000300` adiciona LOSS com hash e resultado terminal obrigatórios. Seu `down` restaura contrato BET/WIN somente sem histórico LOSS; com histórico, recusa reversão sem apagar auditoria. Pare APIs antes de migrar ou reverter.

Migration `20261023000200` adiciona WIN, pendência e referências. Antes de haver WIN, permite down/up; com histórico WIN ou referência, o `down` recusa a reversão e preserva auditoria. Pare as APIs antes da migration. Mapeamentos monetários usam comparação exata de strings sobre as mesmas colunas `numeric(30,2)`, conforme [decisão WIN](ARCHITECTURE.md#crédito-de-win-e-referências).

`postgres-test` usa tmpfs: recriar container descarta dados. `postgres` usa volume persistente. `docker compose down` para serviços sem apagar volume.
