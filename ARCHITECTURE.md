# Arquitetura

## D-001 — Dinheiro exato e domínio isolado (adotada)

`Money` usa centavos `bigint`, sem NestJS, ORM ou conversão para `number`. Entrada e saída usam string decimal canônica com exatamente duas casas; entradas negativas, notação científica, espaços e precisão excedente são rejeitados, nunca arredondados. Subtração e negação podem produzir valores negativos internos para diferenças futuras, sem permitir entrada externa negativa. Operações binárias exigem mesma moeda, inclusive comparação e igualdade.

Moedas ISO reconhecidas por `Intl.supportedValuesOf('currency')` do runtime Bun/ICU. Modelo preserva moeda e testes incluem BRL/USD. Money é congelado em runtime. Wallet encapsula estado, copia datas e usa constructor privado, `open` e `rehydrate`. Reidratação reconstrói saldo e versão persistidos sem reaplicar abertura zero.

Alternativa: biblioteca decimal. Escala fixa de duas casas permite aritmética inteira nativa e exata sem dependência adicional.

## D-002 — Persistência e concorrência da abertura (adotada parcialmente)

Bun 1.3.14, TypeScript 5.9 estrito, NestJS 11.1.16 e MikroORM 6.6.8. Versões fixadas no lockfile; MikroORM 6.6 escolhido como linha estável conhecida, não como versão mais recente. `EntitySchema` separado evita decorators de infraestrutura no domínio. `numeric(30,2)` é lido como string e reconstruído como Money; limite persistido: 28 dígitos inteiros. Domínio usa bigint sem esse limite; este endpoint só aceita zero.

PostgreSQL 17.6 protege unicidade por `(player_id, currency)`, saldo não negativo e exclusão de NaN; versão positiva e colunas obrigatórias também são constraints. Valores decimais fora da escala são rejeitados na entrada HTTP; SQL direto em `numeric(30,2)` segue arredondamento do PostgreSQL e não é contrato de entrada pública.

Abertura zero executa um INSERT via Unit of Work, com commit antes da resposta. Sem pré-consulta de duplicidade: constraint única decide inclusive entre conexões/instâncias concorrentes. Uma criação vence; demais retornam conflito. Falha antes do commit não deixa wallet; falha depois do commit pode perder resposta, mas reenvio encontra unicidade persistida e retorna 409. Não há promessa de replay idempotente da criação.

Saldo não muda: nenhum lançamento, transação OPENING ou evento é criado. Não existem tabelas ledger/outbox neste incremento. Soma de movimentos da abertura é zero; não se afirma implementação de ledger auditável. Saldo positivo é rejeitado antes de qualquer escrita até implementação atômica de OPENING, ledger e outbox no ticket 02. Não existem métodos de crédito/débito prematuros.

Migrations explícitas, versionadas e reversíveis; comando `down` remove tabela de wallets. Startup não migra automaticamente. EntityManager por operação impede compartilhar Identity Map entre requests.

Locks de movimentação, idempotência de apostas e estratégia inbox/outbox continuam pendentes; a proposta de lock pessimista por wallet ainda não foi adotada como implementação.

## Fronteiras, falhas e limites

- HTTP valida objeto e allowlist; domínio valida identidade UUID, dinheiro e abertura zero. Resposta não expõe campos persistidos protegidos.
- 400: `INVALID_WALLET_PAYLOAD`, `INVALID_IDENTITY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INITIAL_BALANCE_MUST_BE_ZERO`.
- 404: `WALLET_NOT_FOUND`; 409: `WALLET_ALREADY_EXISTS`.
- Falha inesperada de infraestrutura: 500 genérico do NestJS, sem SQL/credenciais na resposta. Taxonomia transitória 503 será necessária quando forem entregues operações financeiras/retries; não implementada neste ticket.
- Sem transições financeiras, ledger, SQS, autenticação, health ou métricas neste incremento. Autenticação e ponto de extensão pertencem ao ticket 27; serviço local não é seguro para exposição pública.
- `SIGINT`/`SIGTERM` fecham HTTP antes de encerrar pool. Sem consumer ou ack neste estágio.

## Referências consultadas

- [MikroORM 6.6 EntitySchema](https://mikro-orm.io/docs/6.6/entity-schema): mapeamento sem decorators no domínio.
- [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations): execução programática e reversão.
- [NestJS controllers](https://docs.nestjs.com/controllers): rotas, serialização e códigos padrão 201/200; implementação usa APIs presentes em 11.1.16.
- [Bun/NestJS metadata](https://github.com/oven-sh/bun/blob/main/test/integration/nest/nest_metadata.test.ts): suporte a decorators; compatibilidade com Bun 1.3.14 comprovada executando HTTP real, não inferida do branch main.
