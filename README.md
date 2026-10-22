# Distributed Wagering Processor

Serviço financeiro em implementação incremental para o [desafio técnico](README_TECHNICAL_CHALLENGE.md). Bun, TypeScript estrito, NestJS, MikroORM e PostgreSQL.

**Entregue:** abertura de wallet zerada ou positiva, consulta de saldo e ledger paginado. Abertura positiva persiste wallet, OPENING, CREDIT e dois eventos pendentes em uma transação SQL.

**Pendente:** apostas, reversões, idempotência de transações, reconciliação HTTP, publisher, SQS/inbox, autenticação, health e métricas. Outbox persistida não significa evento publicado. Este estágio não entrega o desafio completo; veja [cobertura por requisito](PROGRESS.md).

## Roteiro para leitura e avaliação

1. Execute API e migrations abaixo.
2. Importe [collection e environment Postman](docs/postman/README.md); percorra abertura, consulta, ledger e erros. Não exige conta ou publicação em workspace.
3. Leia [arquitetura e garantias atuais](ARCHITECTURE.md), [glossário](GLOSSARY.md) e decisões vinculadas.
4. Consulte [evidências executadas](docs/verification.md) e [pendências por requisito](PROGRESS.md). Resultados históricos não substituem execução local.

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

Espere `Wallet HTTP listening` antes de chamar a API: startup ainda não tem health check HTTP. Imagem usa Bun 1.3.14 e dependências de produção com lockfile congelado; Bun no host não é necessário neste modo. Migrations são explícitas, nunca executadas pelo startup.

Porta ocupada: `APP_PORT=3109 docker compose up -d app`; ajuste `baseUrl` no Postman para `http://127.0.0.1:3109`. Dentro da rede Compose, API conecta a `postgres:5432`, não a localhost. Alternativa já verificada em Linux: Podman rootless com Docker Compose como provider; inicie `systemctl --user start podman.socket` e substitua `docker compose` por `podman compose`.

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
```

Dinheiro entra e sai como string decimal com duas casas. Abertura retorna 201; consultas, 200; reenvio de abertura para mesmo player/moeda retorna 409, não replay. Saldo zero não gera lançamento. Contratos, exemplos de resposta, erros e paginação: [guia Postman](docs/postman/README.md).

## Verificação

```sh
bun run typecheck
bun run test:domain
docker compose up -d --wait postgres-test
export TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test
bun run test:integration
bun test
```

Integração exige PostgreSQL real e banco dedicado terminado em `_test`; não pula silenciosamente. Testes aplicam migrations automaticamente. Fixtures de constraints usam rollback; testes HTTP positivos preservam auditoria append-only com identidades novas por execução.

O teste `tests/integration/ledger-http.test.ts` cria e remove banco exclusivo `ledger_<uuid>_test`; usuário precisa de `CREATEDB`. Somente nessa fixture remove-se unicidade de OPENING por wallet para montar histórico sintético. Não altera constraints do banco informado e não comprova movimentações de apostas.

### Reversão e parada

Somente no banco descartável:

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:down
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:up
```

Migration `20261022000300` troca apenas índice. Reverter também `20261022000200` remove ledger, transações e outbox: exige backup antes e serviço parado. Reaplicar schema não recupera auditoria removida.

`postgres-test` usa tmpfs: recriar container descarta dados. `postgres` usa volume persistente. `docker compose down` para serviços sem apagar volume.
