# Distributed Wagering Processor

Serviço financeiro desenvolvido em etapas para o [desafio técnico](README_TECHNICAL_CHALLENGE.md), com Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL.

A API permite abrir wallet com saldo zero ou positivo, consultar saldo, paginar ledger e reconciliar saldo sem reparar dados. Abertura positiva persiste wallet, OPENING, CREDIT e dois eventos pendentes em uma transação SQL.

Apostas, reversões, idempotência de transações, publisher, SQS/inbox, autenticação e health estão pendentes. Métrica e log específicos de reconciliação estão disponíveis; observabilidade dos demais fluxos continua pendente. Os eventos da outbox ainda não são publicados. A [cobertura por requisito](PROGRESS.md) lista o que falta para concluir o desafio.

## Roteiro para leitura e avaliação

1. Execute API e migrations abaixo.
2. Importe [collection e environment Postman](docs/postman/README.md); percorra abertura, consulta, ledger e erros. Não exige conta ou publicação em workspace.
3. Leia [arquitetura e garantias atuais](ARCHITECTURE.md), [glossário](GLOSSARY.md) e decisões vinculadas.
4. Consulte [evidências executadas](docs/verification.md) e [pendências por requisito](PROGRESS.md). Resultados históricos não substituem execução local.

A funcionalidade fica em `src/wallets/`: controller, DTOs, serviço e módulo. `src/app.module.ts` compõe módulos e registra filtro global compartilhado; `src/create-application.ts` recebe o ORM inicializado pelo chamador. Domínio e mapeamentos permanecem separados. Justificativa e injeção de dependências: [ADR-0006](docs/adr/0006-organizacao-modular-nest.md) e [composição na arquitetura](ARCHITECTURE.md#composição-e-injeção).

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

O teste `tests/integration/ledger-http.test.ts` cria e remove um banco exclusivo `ledger_<uuid>_test`; o usuário precisa de `CREATEDB`. A fixture remove a unicidade de OPENING por wallet somente nesse banco para montar um histórico sintético. Ela mantém as constraints do banco informado e não comprova movimentações de apostas.

`tests/integration/reconciliation-http.test.ts` também exige CREATEDB e remove banco exclusivo após execução. Histórico de crédito/débito é sintético: unicidade de OPENING é removida somente nesse banco; não comprova processamento de apostas.

### Reversão e parada

Somente no banco descartável:

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:down
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:up
```

Migration `20261022000300` troca apenas índice. Reverter também `20261022000200` remove ledger, transações e outbox: exige backup antes e serviço parado. Reaplicar schema não recupera auditoria removida.

`postgres-test` usa tmpfs: recriar container descarta dados. `postgres` usa volume persistente. `docker compose down` para serviços sem apagar volume.
