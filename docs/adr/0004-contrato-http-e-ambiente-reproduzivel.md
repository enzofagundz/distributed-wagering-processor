# 4. Contrato HTTP e ambiente reproduzível

## Status

Aceita e adotada. Migra D-004 e as fronteiras HTTP e operacionais registradas junto de D-002. A autenticação entrou depois, no [ADR-0008](0008-autenticacao-com-keycloak.md); as passagens abaixo sobre ausência de autenticação descrevem o incremento original.

## Contexto

O transporte precisa rejeitar estruturas inválidas sem converter dinheiro em número nem substituir invariantes do domínio. Executar TypeScript no Bun não comprova tipos estáticos nem justifica depender da inferência de metadata do parâmetro. O ambiente local deve ter versões reproduzíveis e fronteira de rede explícita.

## Decisão

DTO é contrato de transporte, não entidade de domínio. `OpenWalletDto` e DTO monetário aninhado usam `ValidationPipe`, `ValidateNested` e `Type`, com `class-validator` 0.14.2 e `class-transformer` 0.5.1 no NestJS 11.1.16. `expectedType` é explícito, whitelist rejeita campos extras e conversão implícita permanece desativada. Dinheiro continua textual.

Mensagens de validação transportam códigos existentes, sem refletir valores recebidos. Erros estruturais têm precedência sobre erros de formato. O domínio continua validando UUID, dinheiro e saldo inicial não negativo, independentemente do canal; DTO não substitui invariantes.

`DomainErrorFilter` centraliza a allowlist: 400 para `INVALID_WALLET_PAYLOAD`, `INVALID_IDENTITY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INITIAL_BALANCE_NEGATIVE` e `INVALID_LEDGER_QUERY`; 404 para `WALLET_NOT_FOUND`; 409 para `WALLET_ALREADY_EXISTS`. Apenas a constraint de player/moeda vira duplicata. Falha inesperada de infraestrutura ou código de domínio desconhecido segue tratamento 500 genérico do NestJS, sem SQL ou credenciais na resposta; não é convertida em 400. A consulta tem contrato próprio no [ADR-0005](0005-consulta-estavel-do-ledger.md).

Unit of Work acompanha registros de persistência e organiza seu envio ao PostgreSQL, mas não substitui transação nem constraints. Atomicidade vem da transação externa; unicidade, FKs, aritmética e imutabilidade continuam no schema. SQL direto é apropriado para migrations, inspeção, testes de constraints e leitura parametrizada do ledger, não para escritas ordinárias da abertura.

O Compose executa a imagem `oven/bun:1.3.14`, com dependências do lockfile. O host acessa portas publicadas; os containers usam DNS de serviço. `HOST=0.0.0.0` é necessário dentro do container, mas a publicação padrão `127.0.0.1:3000:3000` limita acesso no host. A execução no host mantém bind padrão `127.0.0.1`. Isso não implementa autenticação.

A imagem instala somente dependências de produção e executa código-fonte. Migrations são comando explícito antes do startup; `bun run typecheck` permanece obrigatório no desenvolvimento porque Bun executa TypeScript sem comprovar correção estática. `SIGINT` e `SIGTERM` fecham HTTP antes do pool; não há consumer ou ack neste estágio.

Nota posterior: a imagem de produção manteve essas escolhas, e o `Dockerfile` ganhou um estágio `development`, usado pelo serviço `app-dev`, para que typecheck, lint e testes também rodem em container. Ver [Ambiente de execução](../../ARCHITECTURE.md#ambiente-de-execução) e as [evidências](../verification.md#toolchain-em-container--2026-10-24).

## Consequências

O domínio permanece reutilizável sem transportar decorators HTTP ou ORM. Reprodutibilidade depende das versões fixadas e do lockfile; evidência de compatibilidade Bun/NestJS vem de HTTP real já registrado, não da versão atual de exemplos upstream.

No incremento original, o serviço não possuía autenticação e não era seguro para exposição pública. Apostas, suas transições, publisher, SQS, health e métricas não integram este incremento. Taxonomia transitória 503 não está implementada; escopo futuro fica na [cobertura do desafio](../../PROGRESS.md).

Fontes: [DTO de abertura](../../src/wallets/open-wallet.dto.ts), [filtro](../../src/shared/domain-error.filter.ts), [startup](../../src/main.ts), [Compose](../../compose.yaml) e [evidências históricas](../verification.md).

Referências: [NestJS controllers](https://docs.nestjs.com/controllers) para rotas e códigos padrão 201/200; [NestJS validation](https://docs.nestjs.com/techniques/validation) para DTOs, whitelist e `exceptionFactory`; [NestJS exception filters](https://docs.nestjs.com/exception-filters) para filtro centralizado com `BaseExceptionFilter`; [Unit of Work 6.6](https://mikro-orm.io/docs/6.6/unit-of-work); [Bun Docker](https://bun.sh/guides/ecosystem/docker); [teste upstream de metadata Bun/NestJS](https://github.com/oven-sh/bun/blob/main/test/integration/nest/nest_metadata.test.ts), que não substitui evidência local com Bun 1.3.14.
