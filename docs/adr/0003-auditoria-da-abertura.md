# 3. Auditoria da abertura

## Status

Aceita e adotada. Migra D-003. O publisher e a política de retry foram entregues nos tickets 15–17; a decisão abaixo registra o escopo da abertura naquela data.

## Contexto

A abertura com saldo positivo precisa de trilha financeira consistente e imutável. Imutabilidade apenas no TypeScript não protege contra escrita SQL direta; INSERTs independentes permitem confirmação parcial após falha.

## Decisão

`WalletLedgerEntry` usa construtor privado, factories, estado congelado e cópias defensivas de datas. `create` valida identidades, valor positivo, saldos não negativos, moeda única e `balanceBefore ± money = balanceAfter`, conforme `CREDIT` ou `DEBIT`. `rehydrate` apenas reconstrói estado persistido. Não há setters nem transições.

PostgreSQL repete a aritmética em CHECKs. FKs compostas mantêm wallet/player/moeda e transação/wallet/moeda/valor consistentes; UNIQUE limita uma OPENING por wallet e um lançamento por transação/wallet. Trigger rejeita UPDATE, DELETE e TRUNCATE do ledger; não há cascatas de exclusão.

Abertura e auditoria usam a mesma transação de aplicação, conforme [ADR-0002](0002-persistencia-e-concorrencia-da-abertura.md). O schema de transações aceita somente `OPENING`/`PROCESSED`, sem simular estados futuros ou retries. A outbox registra envelope e `published_at` nulo; não existe publisher nem política de retry implementada. Escopo pendente: [cobertura do desafio](../../PROGRESS.md).

## Consequências

INSERTs independentes e imutabilidade apenas no TypeScript foram descartados por permitirem inconsistência após falha ou escrita SQL direta. Os testes existentes induzem falha na outbox para verificar rollback das escritas financeiras anteriores e executam aberturas concorrentes para verificar unicidade persistida; as [evidências registradas](../verification.md) não são uma nova execução nesta migração documental.

A proteção contra DML normal não impede administrador de remover triggers ou tabelas. Separar usuário de migrations de usuário da aplicação continua necessário antes de exposição real. O serviço local não é seguro para exposição pública, conforme [ADR-0004](0004-contrato-http-e-ambiente-reproduzivel.md).

Não há promessa de que SQL arbitrário crie wallet positiva com auditoria completa: correspondência entre saldo materializado e ledger depende da transação do caso de uso. Regras e locks de movimentações posteriores não estão entregues.

Fontes: [WalletLedgerEntry](../../src/domain/wallet-ledger-entry.ts), [migration da auditoria](../../src/persistence/migrations/Migration20261022000200.ts), [constraints PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-constraints.html) e [trigger functions PostgreSQL 17](https://www.postgresql.org/docs/17/plpgsql-trigger.html).
