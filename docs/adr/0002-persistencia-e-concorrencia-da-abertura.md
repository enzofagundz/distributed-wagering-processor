# 2. Persistência e concorrência da abertura

## Status

Aceita, parcialmente adotada. Migra D-002: persistência e concorrência da abertura entregues; locks de movimentação, idempotência de apostas, inbox e estratégia de publicação da outbox continuam pendentes. A proposta de lock pessimista por wallet não foi adotada como implementação.

## Contexto

Abertura precisa confirmar wallet e auditoria juntas, sem duplicar wallet em requests concorrentes. O domínio deve continuar independente do ORM, e o banco precisa impor invariantes mesmo diante de escritas SQL diretas. Isso não equivale a implementar concorrência de movimentações financeiras.

## Decisão

Usar Bun 1.3.14, TypeScript 5.9 estrito, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6. As dependências são fixadas no lockfile; MikroORM 6.6 foi escolhido como linha estável conhecida, não como versão mais recente. `EntitySchema` separado mapeia wallet, transação OPENING, ledger e outbox, sem decorators de infraestrutura no domínio.

`numeric(30,2)` é lido como string e reconstruído como `Money`: o limite persistido é de 28 dígitos inteiros. O domínio usa `bigint` sem esse limite; ultrapassar a capacidade SQL falha sem confirmação parcial. PostgreSQL impõe unicidade `(player_id, currency)`, saldo não negativo, exclusão de NaN, versão positiva e colunas obrigatórias. A entrada HTTP rejeita casas excedentes; SQL direto em `numeric(30,2)` segue o arredondamento do PostgreSQL e não constitui contrato público.

Abertura executa `EntityManager.fork().transactional()`. Escritas ordinárias usam `create`/`persistAndFlush`, não INSERT SQL no serviço. Flushes ordenados enviam wallet, OPENING, ledger e eventos dentro da mesma transação; flush não antecipa commit. A ordem respeita FKs compostas das migrations sem duplicar relações no domínio. Commit precede resposta; falha anterior ao commit desfaz tudo.

A constraint única de player/moeda arbitra aberturas concorrentes sem pré-consulta ou lock global. Reenvio após commit retorna 409, não replay idempotente. Apenas a violação `wallets_player_currency_unique` vira `WALLET_ALREADY_EXISTS`; outra unicidade violada é falha inesperada.

Saldo zero cria somente wallet. Saldo positivo cria OPENING interna já `PROCESSED`, um lançamento `CREDIT` de zero até o saldo inicial, versão 1 e dois eventos pendentes: `WagerTransactionProcessed` e `WalletBalanceChanged`. Classes concretas serializam envelope versionado e `MoneyProps`; a correlação é o ID interno da OPENING. Não há identidade fictícia de provedor, rodada ou jogo nem endpoint de submissão de apostas.

Migrations são explícitas, versionadas e reversíveis; startup não migra automaticamente. A migration [20261022000200](../../src/persistence/migrations/Migration20261022000200.ts) adiciona transações, ledger e outbox; `down` descarta esses dados e preserva wallets. Reaplicar DDL não recupera auditoria descartada: rollback de schema com dados exige backup e serviço parado.

## Consequências

Abertura positiva preserva atomicidade entre saldo, auditoria e eventos persistidos, mas não entrega processamento de apostas, locks de movimentação, idempotência, inbox, consumer ou publisher. `published_at` permanece nulo; evento persistido não é evento publicado. Pendências e próximos incrementos estão na [cobertura do desafio](../../PROGRESS.md).

A garantia concorrente atual limita-se à criação única por player/moeda; não comprova proteção contra lost update em movimentações ou execução financeira em múltiplas instâncias. A auditoria e seus limites estão no [ADR-0003](0003-auditoria-da-abertura.md).

Referências: [EntitySchema 6.6](https://mikro-orm.io/docs/6.6/entity-schema), [transações 6.6](https://mikro-orm.io/docs/6.6/transactions), [migrations 6.6](https://mikro-orm.io/docs/6.6/migrations) e [constraints PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-constraints.html). Implementação: [WalletService](../../src/wallet-service.ts).
