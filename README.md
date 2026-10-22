# Distributed Wagering Processor

Implementação incremental do [desafio](README_TECHNICAL_CHALLENGE.md). Entregue: abertura de wallet zerada ou positiva, consulta HTTP e ledger paginado. Abertura positiva registra OPENING, CREDIT e eventos pendentes na mesma transação PostgreSQL. Apostas e processamento de mensageria ainda não implementados. Cobertura completa: [PROGRESS.md](PROGRESS.md).

## Requisitos

- Docker com Docker Compose v2+; Bun 1.3.14 (1.x) no host para desenvolvimento e testes.
- Alternativa verificada em Linux: Podman rootless com Docker Compose como provider (`systemctl --user start podman.socket`; substituir `docker compose` por `podman compose`).
- Portas locais: PostgreSQL 55432, banco descartável de testes 55433, HTTP 3000.

## Execução em containers

```sh
docker compose build app
docker compose up -d --wait postgres
docker compose run --rm app bun run migration:up
docker compose up -d app
docker compose logs app
```

Imagem usa Bun 1.3.14 e `bun install --production --frozen-lockfile`. Não precisa de Bun no host para executar a API ou migrations. Migrations são explícitas; startup não altera schema.

Dentro do Compose, a API acessa `postgres:5432` pelo DNS da rede de serviços e escuta `0.0.0.0:3000`. No host, somente `127.0.0.1:3000` é publicado; `localhost` dentro de um container não aponta para outro serviço. Credenciais e API sem autenticação são exclusivas do ambiente local.

Se a porta 3000 estiver ocupada, use `APP_PORT=3109 docker compose up -d app` e acesse `http://127.0.0.1:3109`. O bind publicado continua em loopback. `up -d` inicia o processo, mas não aguarda prontidão HTTP; espere a mensagem `Wallet HTTP listening` nos logs antes de chamar a API. Health checks da aplicação continuam fora deste ticket.

## Execução no host

```sh
bun install --frozen-lockfile
docker compose up -d --wait postgres postgres-test
export DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55432/wagering
bun run migration:up
bun run start
```

Credenciais são exclusivas do ambiente local. API sem autenticação, vinculada ao loopback; não expor em produção.

## HTTP

```sh
curl -i http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
curl -i http://127.0.0.1:3000/wallets/ID_RETORNADO
curl -i 'http://127.0.0.1:3000/wallets/ID_RETORNADO/ledger?limit=50'
```

`POST /wallets` retorna 201; `GET /wallets/:walletId` retorna 200, ambos com `id`, `playerId`, `balance: { amount, currency }`, `version: 1`. Reenvio de abertura retorna 409, não replay. Saldo zero não gera transação, ledger ou evento; saldo positivo gera uma OPENING processada, um CREDIT e dois eventos na outbox, sem publisher neste incremento. DTOs validam campos aninhados, rejeitam campos adicionais e valores monetários não textuais, sem conversão implícita. As regras financeiras permanecem no domínio para entradas não HTTP.

### Ledger paginado

`GET /wallets/:walletId/ledger` retorna `{ items, nextCursor }`. Cada item contém `id`, `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter` e `createdAt`. Os três campos monetários usam `{ amount: string, currency: string }`, sem conversão para número. `createdAt` preserva o timestamp textual do PostgreSQL, com offset e precisão disponível.

`limit` aceita inteiros decimais canônicos de 1 a 100; padrão 50. Para continuar, envie `cursor` exatamente como recebido em `nextCursor`, mantendo o mesmo `walletId`; `nextCursor: null` encerra a leitura. Exemplo:

```sh
curl -i 'http://127.0.0.1:3000/wallets/ID_RETORNADO/ledger?limit=2&cursor=CURSOR_RETORNADO'
```

Ordem crescente por `(created_at, id)`, com desempate UUID e comparação integral no PostgreSQL. Inserções entre chamadas não deslocam lançamentos existentes. Não é snapshot: novos lançamentos posteriores ao cursor podem aparecer; inserções retroativas anteriores ao cursor exigem reiniciar a leitura para serem vistas. Repetir cursor sem novas inserções no intervalo retorna a mesma página.

400 `INVALID_LEDGER_QUERY`: limite inválido, parâmetros extras/repetidos, cursor malformado, inexistente ou de outra wallet. 400 `INVALID_IDENTITY`: walletId malformado. 404 `WALLET_NOT_FOUND`: wallet inexistente; wallet existente sem lançamentos retorna 200 com `items: []`. Cursor é opaco, não secreto nem credencial. Não há endpoint de escrita do ledger; constraints e trigger append-only permanecem.

## Verificação

```sh
bun run typecheck
bun run test:domain
export TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test
bun run test:integration
bun test tests/integration/ledger-http.test.ts
bun test
```

Integração exige PostgreSQL real; não pula testes silenciosamente. Use banco dedicado com nome terminado em `_test`. Fixtures de constraints usam rollback; aberturas HTTP positivas conservam auditoria append-only no banco descartável, com identidades novas por execução. O arquivo de ledger cria e remove um banco isolado `ledger_<uuid>_test`; o usuário local de testes precisa de `CREATEDB`. Apenas nesse banco, a fixture de múltiplos lançamentos remove a unicidade de OPENING por wallet para preparar histórico sintético enquanto apostas não existem. Não altera constraints do banco informado nem do ambiente de execução. Não rodar contra banco de desenvolvimento/produção. Migrations são aplicadas automaticamente pelos testes, nunca pelo startup HTTP.

Verificado em 2026-10-22 com Podman rootless/Docker Compose: build com Bun 1.3.14 e lockfile congelado, migration executada dentro do container e API publicada em `127.0.0.1:3109` (`APP_PORT=3109`). Smoke HTTP observou 201 na criação, 200 na consulta, oito duplicatas concorrentes com 409 e 400 para dinheiro numérico. Saldo persistido e soma SQL do ledger: `1234567890123456.78 BRL`, versão 1, um CREDIT, uma OPENING processada e dois eventos pendentes; abertura zero sem auditoria.

Verificação atual do ticket 03 no host: `bun run typecheck` e `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: 77 testes aprovados, zero falhas, 324 assertions em sete arquivos. Arquivo de ledger isolado: três testes, 68 assertions; percorre quatro páginas, empate de timestamps, microssegundos e inserções entre consultas. Smoke separado via `bun run start`, porta 3113, contra PostgreSQL de testes em container: criação 201, ledger 200 com `9007199254740993.01 BRL` exato, limite inválido 400 e wallet ausente 404. Migration de índice `20261022000300` executada em up/down/up no banco de testes. Nest Boost MCP, em processo novo, confirmou GET `/wallets/:walletId/ledger`; servidor montado anteriormente manteve snapshot antigo das rotas. Não comprova apostas, SQS ou múltiplas instâncias financeiras.

Reversão manual no banco descartável: a migration mais recente (`20261022000300`) apenas troca o índice de ordenação pelo índice anterior, sem excluir lançamentos. Reverter também `20261022000200` remove ledger, transações e outbox; nesse caso, preservar backup antes de qualquer reversão.

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:down
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:up
```

`postgres-test` usa tmpfs; recriar container descarta dados. `postgres` usa volume persistente. Para parar sem apagar volume: `docker compose down`.

Decisões, limites e referências: [ARCHITECTURE.md](ARCHITECTURE.md). Evidências executadas e próxima etapa: [PROJECT_STATE.md](PROJECT_STATE.md).
