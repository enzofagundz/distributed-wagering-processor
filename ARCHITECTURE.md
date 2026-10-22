# Arquitetura

## D-001 — Dinheiro exato e domínio isolado (adotada)

`Money` usa centavos `bigint`, sem NestJS, ORM ou conversão para `number`. Entrada e saída usam string decimal canônica com exatamente duas casas; entradas negativas, notação científica, espaços e precisão excedente são rejeitados, nunca arredondados. Subtração e negação podem produzir valores negativos internos para diferenças futuras, sem permitir entrada externa negativa. Operações binárias exigem mesma moeda, inclusive comparação e igualdade.

Moedas ISO reconhecidas por `Intl.supportedValuesOf('currency')` do runtime Bun/ICU. Modelo preserva moeda e testes incluem BRL/USD. Money é congelado em runtime. Wallet encapsula estado, copia datas e usa constructor privado, `open` e `rehydrate`. Reidratação reconstrói saldo e versão persistidos sem reaplicar abertura.

Alternativa: biblioteca decimal. Escala fixa de duas casas permite aritmética inteira nativa e exata sem dependência adicional.

## D-002 — Persistência e concorrência da abertura (adotada parcialmente)

Bun 1.3.14, TypeScript 5.9 estrito, NestJS 11.1.16 e MikroORM 6.6.8. Versões fixadas no lockfile; MikroORM 6.6 escolhido como linha estável conhecida, não como versão mais recente. `EntitySchema` separado evita decorators de infraestrutura no domínio. `numeric(30,2)` é lido como string e reconstruído como Money; limite persistido: 28 dígitos inteiros. Domínio usa bigint sem esse limite; exceder capacidade SQL falha sem confirmação parcial.

PostgreSQL 17.6 protege unicidade por `(player_id, currency)`, saldo não negativo e exclusão de NaN; versão positiva e colunas obrigatórias também são constraints. Valores decimais fora da escala são rejeitados na entrada HTTP; SQL direto em `numeric(30,2)` segue arredondamento do PostgreSQL e não é contrato de entrada pública.

Abertura usa `EntityManager.fork().transactional()`: `EntitySchema` separados mapeiam wallet, OPENING, ledger e outbox. Escritas ordinárias usam `create`/`persistAndFlush`, sem INSERT SQL no serviço. Flushes ordenados confirmam wallet, depois OPENING, depois ledger e por fim eventos dentro da mesma transação; flush envia SQL, mas não antecipa commit. A ordem explícita preserva FKs compostas mantidas nas migrations, sem duplicar essas relações no domínio. Commit precede resposta. Constraint única `(player_id, currency)` arbitra requests concorrentes sem pré-consulta ou lock global. Falha anterior ao commit desfaz tudo; reenvio após commit retorna 409, não replay da abertura.

Saldo zero não cria transação, ledger ou evento. Saldo positivo cria uma transação interna `OPENING` já `PROCESSED`, um lançamento `CREDIT` de zero até o saldo inicial, versão 1 e eventos `WagerTransactionProcessed`/`WalletBalanceChanged` pendentes na outbox. Classes concretas serializam envelope versionado e MoneyProps; correlação é o ID interno da OPENING. OPENING não possui identidade de provedor, rodada ou jogo fictícios; ainda não existe endpoint de submissão de apostas.

Migrations explícitas, versionadas e reversíveis. A segunda adiciona transações, ledger e outbox; `down` descarta esses dados, preservando wallets. Reaplicar DDL não recupera auditoria descartada: rollback de schema com dados exige backup e serviço parado. Startup não migra automaticamente.

Locks de movimentação, idempotência de apostas e estratégia inbox/outbox continuam pendentes; a proposta de lock pessimista por wallet ainda não foi adotada como implementação.

## Fronteiras, falhas e limites

- HTTP usa `OpenWalletDto` e DTO monetário aninhado, `ValidationPipe`, `ValidateNested` e `Type`. Whitelist rejeita campos extras; conversão implícita desativada preserva dinheiro textual. `expectedType` é explícito: a execução TypeScript pelo Bun não deve depender de inferência de metadata do parâmetro.
- DTO valida formato e estrutura do contrato. Domínio continua validando identidade UUID, dinheiro e saldo inicial não negativo, inclusive para futuros canais não HTTP. DTO não substitui invariantes.
- 400: `INVALID_WALLET_PAYLOAD`, `INVALID_IDENTITY`, `INVALID_AMOUNT`, `INVALID_CURRENCY`, `INITIAL_BALANCE_NEGATIVE`.
- `DomainErrorFilter` centraliza allowlist de erros conhecidos: 404 `WALLET_NOT_FOUND`; 409 `WALLET_ALREADY_EXISTS`. Somente a constraint de player/moeda é traduzida para duplicata; outra violação de unicidade é falha inesperada.
- Falha inesperada de infraestrutura ou código de domínio desconhecido: 500 genérico do NestJS, sem SQL/credenciais na resposta. Taxonomia transitória 503 será necessária quando forem entregues operações financeiras/retries; não implementada neste ticket.
- Sem apostas, transições de apostas, publisher, SQS, autenticação, health ou métricas neste incremento. Eventos ficam persistidos, não publicados. Autenticação e ponto de extensão pertencem ao ticket 27; serviço local não é seguro para exposição pública.
- `SIGINT`/`SIGTERM` fecham HTTP antes de encerrar pool. Sem consumer ou ack neste estágio.

## D-003 — Auditoria da abertura (adotada)

`WalletLedgerEntry` possui constructor privado, factories, estado congelado e cópias defensivas de datas. `create` exige valor positivo, saldos não negativos, moeda única e `balanceBefore ± money = balanceAfter`; `rehydrate` apenas reconstrói estado. Não há setters ou transições.

PostgreSQL repete a aritmética com CHECK; FKs compostas mantêm wallet/player/moeda e transação/wallet/moeda/valor consistentes. UNIQUE limita OPENING por wallet e lançamento por transação/wallet. Trigger rejeita UPDATE, DELETE e TRUNCATE do ledger, sem cascatas de exclusão. Isso protege DML normal, não um administrador capaz de remover triggers/tabelas; separar usuário de migrations de usuário da aplicação continua necessário antes de exposição real.

Alternativa descartada: INSERTs independentes ou imutabilidade apenas TypeScript. Ambos permitem inconsistência após falha ou escrita SQL direta. Falha induzida na outbox verifica rollback das escritas financeiras anteriores; concorrência de aberturas verifica unicidade persistida. Não há promessa de que SQL arbitrário possa criar uma wallet positiva sem usar o caso de uso: correspondência completa saldo/ledger depende da transação de aplicação; movimentações futuras exigirão seus próprios locks e regras.

Schema de transações restringe este incremento a OPENING/PROCESSED; não simula estados futuros nem retries. Outbox registra envelope e `published_at` nulo; publisher e política de retry serão entregues em tickets próprios, sem publicação antes do commit.

## D-004 — Contrato HTTP e ambiente reproduzível (adotada)

DTO é contrato de transporte, não entidade de domínio. `class-validator` 0.14.2 e `class-transformer` 0.5.1 integram validação aninhada ao NestJS 11.1.16; mensagens de validação carregam códigos existentes, sem refletir valores recebidos. Erros estruturais têm precedência sobre formato. Erros inesperados não são convertidos em 400.

Unit of Work acompanha registros de persistência e organiza seu envio ao PostgreSQL. Não substitui transação nem constraints: atomicidade vem da transação externa; unicidade, FKs, aritmética e imutabilidade continuam no schema. SQL direto permanece apropriado para migrations, inspeção e testes de constraints, não para as escritas ordinárias deste fluxo.

Compose executa imagem `oven/bun:1.3.14` com dependências do lockfile. Host usa portas publicadas; containers usam DNS de serviço. `HOST=0.0.0.0` é necessário dentro do container, mas publicação `127.0.0.1:3000:3000` limita acesso no host. Execução no host mantém bind padrão `127.0.0.1`. Isso não implementa autenticação.

Bun executa TypeScript sem comprovar correção estática: `bun run typecheck` continua obrigatório no host de desenvolvimento. Imagem instala somente dependências de produção e executa código-fonte; migrations são comando explícito antes do startup.

## D-005 — Consulta estável do ledger (adotada)

`GET /wallets/:walletId/ledger` usa keyset crescente por `(created_at, id)`. UUID é desempate único; índice `(wallet_id, created_at, id)` atende filtro e ordenação. Migration `20261022000300` substitui o índice simples de wallet; `down` restaura o índice anterior, sem tocar dados.

Cursor opaco é o ID UUID do último lançamento retornado, codificado em base64url canônico. Não é token de autorização nem possui assinatura: cliente não deve interpretá-lo; servidor aceita somente ID existente na mesma wallet. Alterá-lo para outro lançamento da mesma wallet escolhe outra posição de leitura, sem permitir escrita ou acesso a outra wallet. Não há autenticação neste estágio.

Consulta parametrizada pelo MikroORM compara tuplas no PostgreSQL, buscando timestamp diretamente do lançamento apontado pelo cursor. Não converte timestamp em `Date` para retomar página: isso perderia microssegundos do PostgreSQL e poderia repetir ou omitir linhas. A resposta mantém timestamp textual com offset e dinheiro como string decimal. Leitura busca `limit + 1`, devolve no máximo `limit` e só emite `nextCursor` quando há outro lançamento.

`LedgerQueryDto` com `@Query` e `ValidationPipe` segue convenção existente: `expectedType` explícito, whitelist estrita e conversão implícita desativada. Limite textual canônico 1–100, padrão 50; conversão explícita para número ocorre apenas no tamanho da página, nunca no dinheiro. Erros de query retornam 400 `INVALID_LEDGER_QUERY`; identidade inválida continua 400; wallet ausente é 404, distinta de histórico vazio 200. Consulta não escreve em wallet, ledger, transação ou outbox.

Alternativa descartada: `OFFSET`, que desloca páginas quando há inserções antes da posição lida. Keyset preserva lançamentos existentes em ordem, inclusive empates e microssegundos, mas não mantém snapshot entre requests. Novas linhas posteriores ao cursor podem aparecer; linhas inseridas retroativamente antes dele só aparecem em nova travessia. Ledger append-only mantém âncora do cursor válida; reiniciar processo não perde posição porque âncora vive no PostgreSQL.

Teste pela fronteira HTTP real, com PostgreSQL em container. Banco exclusivo por execução permite preparar múltiplos lançamentos sem modificar banco compartilhado: somente nessa fixture remove-se unicidade de OPENING por wallet, pois schema atual ainda restringe transações a OPENING. Histórico sintético verifica leitura, não implementação de apostas ou consistência financeira de movimentações futuras. Trigger de imutabilidade, aritmética, FKs e unicidade de lançamento/transação permanecem ativos. Usuário local de teste exige permissão de criar banco; teardown remove banco exclusivo.




## Referências consultadas

- [MikroORM 6.6 EntitySchema](https://mikro-orm.io/docs/6.6/entity-schema): mapeamento sem decorators no domínio.
- [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations): execução programática e reversão.
- [NestJS controllers](https://docs.nestjs.com/controllers): rotas, serialização e códigos padrão 201/200; implementação usa APIs presentes em 11.1.16.
- [Bun/NestJS metadata](https://github.com/oven-sh/bun/blob/main/test/integration/nest/nest_metadata.test.ts): suporte a decorators; compatibilidade com Bun 1.3.14 comprovada executando HTTP real, não inferida do branch main.
- [MikroORM 6.6 transações](https://mikro-orm.io/docs/6.6/transactions): transação explícita inclui Unit of Work e SQL customizado; flush interno não antecipa commit externo.
- [PostgreSQL 17 constraints](https://www.postgresql.org/docs/17/ddl-constraints.html): CHECK para aritmética local, UNIQUE e FKs para relações.
- [PostgreSQL 17 trigger functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html): exceção aborta UPDATE/DELETE/TRUNCATE de auditoria.
- [NestJS validation](https://docs.nestjs.com/techniques/validation): DTOs, whitelist, `exceptionFactory` e rejeição de campos extras; APIs verificadas com NestJS 11.1.16.
- [NestJS exception filters](https://docs.nestjs.com/exception-filters): filtro centralizado com `BaseExceptionFilter` preserva tratamento genérico de falhas inesperadas.
- [Bun Docker](https://bun.sh/guides/ecosystem/docker): imagem oficial, instalação com lockfile e execução do código-fonte; projeto fixa versão em vez da tag genérica do exemplo.
- [MikroORM 6.6 Unit of Work](https://mikro-orm.io/docs/6.6/unit-of-work): persistência e flush não substituem fronteira transacional.
- [NestJS validation](https://docs.nestjs.com/techniques/validation): consulta via Context7 para `ValidationPipe`, whitelist e `exceptionFactory`; compatibilidade comprovada no NestJS 11.1.16 por HTTP real. Nest Boost MCP inspecionou rotas e DI existentes e confirmou nova rota em processo novo; servidor persistente anterior manteve snapshot antigo.
