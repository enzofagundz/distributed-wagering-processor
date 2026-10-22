# Distributed Wagering Processor

Implementação incremental do [desafio](README_TECHNICAL_CHALLENGE.md). Entregue: abertura de wallet **somente zerada** e consulta HTTP. Demais operações financeiras e mensageria ainda não implementadas. Cobertura completa: [PROGRESS.md](PROGRESS.md).

## Requisitos

- Bun 1.3.14 (1.x), Docker com Docker Compose v2+.
- Alternativa verificada em Linux: Podman rootless com Docker Compose como provider (`systemctl --user start podman.socket`; substituir `docker compose` por `podman compose`).
- Portas locais: PostgreSQL 55432, banco descartável de testes 55433, HTTP 3000.

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
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"0.00","currency":"BRL"}}'
curl -i http://127.0.0.1:3000/wallets/ID_RETORNADO
```

POST retorna 201; GET retorna 200, ambos com `id`, `playerId`, `balance: { amount, currency }`, `version: 1`. Reenvio de abertura retorna 409, não replay. Saldo inicial positivo retorna 400 neste incremento; abertura positiva com OPENING/ledger pertence ao próximo ticket. Campos adicionais são rejeitados.

## Verificação

```sh
bun run typecheck
bun run test:domain
export TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test
bun run test:integration
bun test
```

Integração exige PostgreSQL real; não pula testes silenciosamente. Use banco dedicado com nome terminado em `_test`. Testes criam somente suas wallets e as removem; não rodar contra banco de desenvolvimento/produção. Migrations são aplicadas automaticamente pelos testes, nunca pelo startup HTTP.

Validação do ticket 01: typecheck aprovado, 37 testes aprovados com PostgreSQL real; smoke HTTP 201/200/409 e migrations up/down/up executados. Registro detalhado local: [PROJECT_STATE.md](PROJECT_STATE.md). Revisão independente de standards e spec contra `e3b41eb`: nenhum achado no escopo do ticket.

Reversão manual no banco descartável (remove tabela e dados de wallets):

```sh
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:down
DATABASE_URL="$TEST_DATABASE_URL" bun run migration:up
```

`postgres-test` usa tmpfs; recriar container descarta dados. `postgres` usa volume persistente. Para parar sem apagar volume: `docker compose down`.

Decisões, limites e referências: [ARCHITECTURE.md](ARCHITECTURE.md). Evidências executadas e próxima etapa: [PROJECT_STATE.md](PROJECT_STATE.md).
