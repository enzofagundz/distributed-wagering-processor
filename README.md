# Distributed Wagering Processor

Serviço financeiro desenvolvido em etapas para o [desafio técnico](README_TECHNICAL_CHALLENGE.md), com Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL.

A API permite abrir wallet, consultar saldo, paginar ledger, reconciliar sem reparar dados e processar BET por HTTP. Transações podem ser consultadas por ID interno ou identidade do provedor. Abertura positiva e BET confirmada persistem saldo, transação, ledger e eventos pendentes na mesma transação SQL.

WIN, LOSS, reversões, publisher, SQS/inbox, autenticação e health estão pendentes. Métrica e log específicos de reconciliação estão disponíveis; observabilidade dos demais fluxos continua pendente. Os eventos da outbox ainda não são publicados. A [cobertura por requisito](PROGRESS.md) lista o que falta para concluir o desafio.

## Roteiro para leitura e avaliação

1. Execute API e migrations abaixo.
2. Importe [collection e environment Postman](docs/postman/README.md); percorra abertura, consulta, ledger e erros. Não exige conta ou publicação em workspace.
3. Leia [arquitetura e garantias atuais](ARCHITECTURE.md), [glossário](GLOSSARY.md) e decisões vinculadas.
4. Consulte [evidências executadas](docs/verification.md) e [pendências por requisito](PROGRESS.md). Resultados históricos não substituem execução local.

Wallets ficam em `src/wallets/`; submissão de BET, em `src/wagering/`. Cada funcionalidade tem controller, DTO, serviço e módulo. `src/app.module.ts` compõe módulos e registra filtro global compartilhado; `src/create-application.ts` recebe o ORM inicializado pelo chamador. Domínio e mapeamentos permanecem separados. Justificativa e injeção de dependências: [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) e [composição na arquitetura](ARCHITECTURE.md#composição-e-injeção).

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
docker compose up -d --wait postgres postgres-test
export DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55432/wagering
bun run migration:up
bun run start
```

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

Envie outra aposta de `80.00` com nova chave e novo `externalTransactionId`: retorna 422 com `REJECTED`, `failureCode: "INSUFFICIENT_FUNDS"` e saldo `20.00`. Rejeição fica auditada, sem ledger nem incremento de versão. Header obrigatório; somente BET externa é aceita. Identificadores textuais têm até 200 caracteres; valor deve ser positivo e caber em `numeric(30,2)`.

Reenvie exatamente a primeira BET com a mesma chave: retorna 201, identidade e saldo originais, com `idempotentReplay: true`, mesmo após outras apostas ou reinício. Payload diferente com a mesma chave retorna 409 `IDEMPOTENCY_CONFLICT`. Outra chave com o mesmo par provider/external ID retorna 409 `TRANSACTION_ALREADY_EXISTS`. Nenhum desses reenvios gera novo débito ou evento. Chave tem escopo global; identidade externa tem escopo por provider. Hash, precedência dos conflitos e política HTTP: [idempotência de BET](ARCHITECTURE.md#idempotência-de-bet).

### Consultar transação

```sh
curl -i http://127.0.0.1:3000/wagering/transactions/TRANSACTION_ID_RETORNADO
curl -i http://127.0.0.1:3000/providers/provider-a/wagering/transactions/bet-001
```

As duas rotas retornam 200 com a mesma representação: `transactionId`, `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `status`, `balance`, `createdAt` e `processedAt`. Rejeições incluem `failureCode`; consultá-las retorna 200, não o 422 da submissão. `balance` é o saldo observado na operação, não o atual. Consulta não executa aposta nem retorna `idempotentReplay`, chave de idempotência ou hash.

UUID inválido retorna 400 `INVALID_IDENTITY`; provider inválido, 400 `INVALID_PROVIDER`; identidade externa inválida, 400 `INVALID_IDENTITY`. Identidade válida ausente retorna 404 `TRANSACTION_NOT_FOUND`. Provider e ID externo são sensíveis a maiúsculas; codifique cada segmento com percent-encoding quando necessário. OPENING pode ser consultada por ID interno, sem identidade de provedor nem saldo observado. Contrato e decisão: [arquitetura](ARCHITECTURE.md#consulta-de-transação).

Teste focal: `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/transaction-query-http.test.ts`. Usa o mesmo setup PostgreSQL abaixo, sem nova migration.

## Verificação

```sh
bun run typecheck
bun run test:domain
docker compose up -d --wait postgres-test
export TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test
bun run test:integration
bun test
```

A integração exige PostgreSQL real e banco dedicado terminado em `_test`; os testes falham se esses requisitos não forem atendidos. Os testes aplicam migrations automaticamente. Fixtures de constraints usam rollback; testes HTTP positivos preservam auditoria append-only com identidades novas por execução.

Para verificar somente BET: `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/bet-http.test.ts`. O arquivo cobre contrato, sucesso, rejeição, rollback induzido, replay, conflitos, reinício de aplicação/pool e três APIs independentes no mesmo processo disputando a mesma chave. Prova com três processos pertence ao ticket 08.

O teste `tests/integration/ledger-http.test.ts` cria e remove um banco exclusivo `ledger_<uuid>_test`; o usuário precisa de `CREATEDB`. A fixture remove a unicidade de OPENING por wallet somente nesse banco para montar um histórico sintético. Ela mantém as constraints do banco informado e não comprova movimentações de apostas.

`tests/integration/reconciliation-http.test.ts` também exige CREATEDB e remove banco exclusivo após execução. Histórico de crédito/débito é sintético: unicidade de OPENING é removida somente nesse banco; não comprova processamento de apostas.

### Reversão e parada

Somente no banco descartável:

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:down
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:up
```

Migration `20261022000400` preserva OPENING e adiciona BET; seu `down` recusa execução se houver BET persistida, sem apagar histórico. Migration `20261022000300` troca apenas índice. Reverter também `20261022000200` remove ledger, transações e outbox: exige backup antes e serviço parado. Reaplicar schema não recupera auditoria removida.

Migration `20261023000100` adiciona hash obrigatório para BET, preenche histórico existente e preserva OPENING sem hash. Seu `down` remove apenas hash e check; histórico financeiro permanece. Pare todas as APIs antes de migrar ou reverter; código antigo não grava o hash exigido pelo novo schema.

`postgres-test` usa tmpfs: recriar container descarta dados. `postgres` usa volume persistente. `docker compose down` para serviços sem apagar volume.
