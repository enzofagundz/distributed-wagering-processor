# Distributed Wagering Processor

Serviço financeiro desenvolvido em etapas para o [desafio técnico](README_TECHNICAL_CHALLENGE.md), com Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL.

A API permite abrir wallet, consultar saldo, paginar ledger, reconciliar sem reparar dados e processar BET e WIN por HTTP. Transações podem ser consultadas por ID interno ou identidade do provedor. Abertura positiva e operações confirmadas persistem saldo, transação, ledger e eventos pendentes na mesma transação SQL.

LOSS, reversões, publisher, SQS/inbox, autenticação e health estão pendentes. WIN com referência ainda indisponível fica persistida, sem crédito; o worker de resolução também está pendente. Métrica e log específicos de reconciliação estão disponíveis; observabilidade dos demais fluxos continua pendente. Os eventos da outbox ainda não são publicados. A [cobertura por requisito](PROGRESS.md) lista o que falta para concluir o desafio.

## Roteiro para leitura e avaliação

1. Execute API e migrations abaixo.
2. Importe [collection e environment Postman](docs/postman/README.md); percorra abertura, ledger, BET, replay, consultas e reconciliação. O guia inclui disputa manual entre três instâncias. Não exige conta ou publicação em workspace.
3. Leia [arquitetura e garantias atuais](ARCHITECTURE.md), [glossário](GLOSSARY.md) e decisões vinculadas.
4. Consulte [evidências executadas](docs/verification.md) e [pendências por requisito](PROGRESS.md). Resultados históricos não substituem execução local.

Wallets ficam em `src/wallets/`; submissão de BET e WIN, em `src/wagering/`. Cada funcionalidade tem controller, DTO, serviço e módulo. `src/app.module.ts` compõe módulos e registra filtro global compartilhado; `src/create-application.ts` recebe o ORM inicializado pelo chamador. Domínio e mapeamentos permanecem separados. Justificativa e injeção de dependências: [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) e [composição na arquitetura](ARCHITECTURE.md#composição-e-injeção).

## Executar

Requisitos: Docker com Compose v2+. Para desenvolvimento/testes no host: Bun 1.3.14. Portas locais: HTTP 3000, PostgreSQL 55432 e banco descartável de testes 55433.

### Containers

```sh
docker compose build app
docker compose up -d --wait postgres
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
docker compose up -d --wait postgres postgres-test
bun run migration:up
bun run start
```

Bun lê `.env` automaticamente ao iniciar a aplicação, executar migrations ou rodar testes. O comando de cópia preserva um `.env` existente; nesse caso, complete as chaves que faltam. As URLs separam desenvolvimento (`55432/wagering`) de testes (`55433/wagering_test`). `HOST` e `PORT` definem onde a API escuta.

O Git ignora `.env` e suas variantes locais. Somente `.env.example` entra no repositório, com valores para o Compose local.

Variáveis exportadas no terminal têm prioridade sobre `.env`. Se uma configuração antiga persistir, remova o export ou abra um terminal sem essa variável. Para rodar três APIs com o mesmo `.env`, mude apenas a porta: `PORT=3101 bun run start`, `PORT=3102 bun run start` e `PORT=3103 bun run start`, cada comando em um terminal.

No container da API, o Compose define `DATABASE_URL`, `HOST` e `PORT`: banco em `postgres:5432` e bind em `0.0.0.0`. Essas configurações não vêm do `.env` do host, e a imagem exclui arquivos `.env`. Para mudar a porta publicada pelo Compose, defina `APP_PORT` no `.env` local.

**Ambiente exclusivamente local, sem autenticação. Não expor em produção.** Credenciais do Compose são locais. Publicação HTTP fica em loopback; bind interno do container é `0.0.0.0`. No host, bind padrão é `127.0.0.1`.

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

Envie outra aposta de `80.00` com nova chave e novo `externalTransactionId`: retorna 422 com `REJECTED`, `failureCode: "INSUFFICIENT_FUNDS"` e saldo `20.00`. Rejeição fica auditada, sem ledger nem incremento de versão. Header obrigatório; BET e WIN são os kinds externos aceitos. Identificadores textuais têm até 200 caracteres; valor deve ser positivo e caber em `numeric(30,2)`.

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

Referência informada ainda inexistente ou não terminal retorna 202 `PENDING_REFERENCE`, sem crédito. Reenvio mantém a pendência; não tenta resolvê-la. Não há worker de resolução neste estágio. Decisão e limites: [WIN e referências](ARCHITECTURE.md#crédito-de-win-e-referências).

Teste focal com PostgreSQL de testes iniciado: `bun test tests/integration/win-http.test.ts`.

### Consultar transação

```sh
curl -i http://127.0.0.1:3000/wagering/transactions/TRANSACTION_ID_RETORNADO
curl -i http://127.0.0.1:3000/providers/provider-a/wagering/transactions/bet-001
```

As duas rotas retornam 200 com a mesma representação: `transactionId`, `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `status`, `balance`, `createdAt` e `processedAt`. WIN inclui `referenceExternalTransactionId` quando informada e `referenceTransactionId` quando resolvida. Pendência tem `processedAt: null`. Rejeições incluem `failureCode`; consultá-las retorna 200, não o 422 da submissão. `balance` é o saldo observado na operação, não o atual. Consulta não processa operação nem retorna `idempotentReplay`, chave de idempotência ou hash.

UUID inválido retorna 400 `INVALID_IDENTITY`; provider inválido, 400 `INVALID_PROVIDER`; identidade externa inválida, 400 `INVALID_IDENTITY`. Identidade válida ausente retorna 404 `TRANSACTION_NOT_FOUND`. Provider e ID externo são sensíveis a maiúsculas; codifique cada segmento com percent-encoding quando necessário. OPENING pode ser consultada por ID interno, sem identidade de provedor nem saldo observado. Contrato e decisão: [arquitetura](ARCHITECTURE.md#consulta-de-transação).

Teste focal: `bun test tests/integration/transaction-query-http.test.ts`. Usa `TEST_DATABASE_URL` do `.env` e o mesmo setup PostgreSQL abaixo, sem nova migration.

## Verificação

```sh
test -f .env || cp .env.example .env
bun run typecheck
bun run test:domain
docker compose up -d --wait postgres-test
bun run test:integration
bun test
```

A integração exige PostgreSQL real e banco dedicado terminado em `_test`; os testes falham se esses requisitos não forem atendidos. Os testes aplicam migrations automaticamente. Fixtures de constraints usam rollback; testes HTTP positivos preservam auditoria append-only com identidades novas por execução.

Para verificar somente BET: `bun test tests/integration/bet-http.test.ts`. O arquivo cobre contrato, sucesso, rejeição, rollback induzido, replay, conflitos e reinício de aplicação/pool.

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

Migration `20261023000200` adiciona WIN, pendência e referências. Antes de haver WIN, permite down/up; com histórico WIN ou referência, o `down` recusa a reversão e preserva auditoria. Pare as APIs antes da migration. Mapeamentos monetários usam comparação exata de strings sobre as mesmas colunas `numeric(30,2)`, conforme [decisão WIN](ARCHITECTURE.md#crédito-de-win-e-referências).

`postgres-test` usa tmpfs: recriar container descarta dados. `postgres` usa volume persistente. `docker compose down` para serviços sem apagar volume.
