# Arquitetura

## D-001 — Dinheiro exato e domínio isolado (adotada)

`Money` usa centavos `bigint`, sem NestJS, ORM ou conversão para `number`. Entrada e saída usam string decimal canônica com exatamente duas casas; entradas negativas, notação científica, espaços e precisão excedente são rejeitados, nunca arredondados. Subtração e negação podem produzir valores negativos internos para diferenças futuras, sem permitir entrada externa negativa. Operações binárias exigem mesma moeda, inclusive comparação e igualdade.

Moedas ISO reconhecidas por `Intl.supportedValuesOf('currency')` do runtime Bun/ICU. Modelo preserva moeda e testes incluem BRL/USD. Money é congelado em runtime. Wallet encapsula estado, copia datas e usa constructor privado, `open` e `rehydrate`. Reidratação reconstrói saldo e versão persistidos sem reaplicar abertura.

Alternativa: biblioteca decimal. Escala fixa de duas casas permite aritmética inteira nativa e exata sem dependência adicional.

## D-002 — Persistência e concorrência da abertura (adotada parcialmente)

Bun 1.3.14, TypeScript 5.9 estrito, NestJS 11.1.16 e MikroORM 6.6.8. Versões fixadas no lockfile; MikroORM 6.6 escolhido como linha estável conhecida, não como versão mais recente. `EntitySchema` separado evita decorators de infraestrutura no domínio. `numeric(30,2)` é lido como string e reconstruído como Money; limite persistido: 28 dígitos inteiros. Domínio usa bigint sem esse limite; exceder capacidade SQL falha sem confirmação parcial.

PostgreSQL 17.6 protege unicidade por `(player_id, currency)`, saldo não negativo e exclusão de NaN; versão positiva e colunas obrigatórias também são constraints. Valores decimais fora da escala são rejeitados na entrada HTTP; SQL direto em `numeric(30,2)` segue arredondamento do PostgreSQL e não é contrato de entrada pública.

Abertura usa `EntityManager.fork().transactional()`: wallet é persistida antes dos INSERTs SQL de auditoria, todos usando o EntityManager transacional. Commit precede resposta. Constraint única `(player_id, currency)` arbitra requests concorrentes sem pré-consulta ou lock global. Falha anterior ao commit desfaz tudo; reenvio após commit retorna 409, não replay da abertura.

Saldo zero não cria transação, ledger ou evento. Saldo positivo cria uma transação interna `OPENING` já `PROCESSED`, um lançamento `CREDIT` de zero até o saldo inicial, versão 1 e eventos `WagerTransactionProcessed`/`WalletBalanceChanged` pendentes na outbox. Classes concretas serializam envelope versionado e MoneyProps; correlação é o ID interno da OPENING. OPENING não possui identidade de provedor, rodada ou jogo fictícios; ainda não existe endpoint de submissão de apostas.

Migrations explícitas, versionadas e reversíveis. A segunda adiciona transações, ledger e outbox; `down` descarta esses dados, preservando wallets. Reaplicar DDL não recupera auditoria descartada: rollback de schema com dados exige backup e serviço parado. Startup não migra automaticamente.

Locks de movimentação, idempotência de apostas e estratégia inbox/outbox continuam pendentes; a proposta de lock pessimista por wallet ainda não foi adotada como implementação.

## Fronteiras, falhas e limites

- HTTP valida objeto e allowlist; domínio valida identidade UUID, dinheiro e saldo inicial não negativo. Resposta não expõe campos persistidos protegidos.
- 400: `INVALID_WALLET_PAYLOAD`, `INVALID_IDENTITY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INITIAL_BALANCE_NEGATIVE`.
- 404: `WALLET_NOT_FOUND`; 409: `WALLET_ALREADY_EXISTS`.
- Falha inesperada de infraestrutura: 500 genérico do NestJS, sem SQL/credenciais na resposta. Taxonomia transitória 503 será necessária quando forem entregues operações financeiras/retries; não implementada neste ticket.
- Sem apostas, transições de apostas, publisher, SQS, autenticação, health ou métricas neste incremento. Eventos ficam persistidos, não publicados. Autenticação e ponto de extensão pertencem ao ticket 27; serviço local não é seguro para exposição pública.
- `SIGINT`/`SIGTERM` fecham HTTP antes de encerrar pool. Sem consumer ou ack neste estágio.

## D-003 — Auditoria da abertura (adotada)

`WalletLedgerEntry` possui constructor privado, factories, estado congelado e cópias defensivas de datas. `create` exige valor positivo, saldos não negativos, moeda única e `balanceBefore ± money = balanceAfter`; `rehydrate` apenas reconstrói estado. Não há setters ou transições.

PostgreSQL repete a aritmética com CHECK; FKs compostas mantêm wallet/player/moeda e transação/wallet/moeda/valor consistentes. UNIQUE limita OPENING por wallet e lançamento por transação/wallet. Trigger rejeita UPDATE, DELETE e TRUNCATE do ledger, sem cascatas de exclusão. Isso protege DML normal, não um administrador capaz de remover triggers/tabelas; separar usuário de migrations de usuário da aplicação continua necessário antes de exposição real.

Alternativa descartada: INSERTs independentes ou imutabilidade apenas TypeScript. Ambos permitem inconsistência após falha ou escrita SQL direta. Falha induzida na outbox verifica rollback das escritas financeiras anteriores; concorrência de aberturas verifica unicidade persistida. Não há promessa de que SQL arbitrário possa criar uma wallet positiva sem usar o caso de uso: correspondência completa saldo/ledger depende da transação de aplicação; movimentações futuras exigirão seus próprios locks e regras.

Schema de transações restringe este incremento a OPENING/PROCESSED; não simula estados futuros nem retries. Outbox registra envelope e `published_at` nulo; publisher e política de retry serão entregues em tickets próprios, sem publicação antes do commit.


## Referências consultadas

- [MikroORM 6.6 EntitySchema](https://mikro-orm.io/docs/6.6/entity-schema): mapeamento sem decorators no domínio.
- [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations): execução programática e reversão.
- [NestJS controllers](https://docs.nestjs.com/controllers): rotas, serialização e códigos padrão 201/200; implementação usa APIs presentes em 11.1.16.
- [Bun/NestJS metadata](https://github.com/oven-sh/bun/blob/main/test/integration/nest/nest_metadata.test.ts): suporte a decorators; compatibilidade com Bun 1.3.14 comprovada executando HTTP real, não inferida do branch main.
- [MikroORM 6.6 transações](https://mikro-orm.io/docs/6.6/transactions): transação explícita inclui Unit of Work e SQL customizado; flush interno não antecipa commit externo.
- [PostgreSQL 17 constraints](https://www.postgresql.org/docs/17/ddl-constraints.html): CHECK para aritmética local, UNIQUE e FKs para relações.
- [PostgreSQL 17 trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html): exceção aborta UPDATE/DELETE/TRUNCATE de auditoria.
