# Evidências de verificação

Estes registros são históricos e não garantem que os comandos foram reexecutados na sua máquina. Setup e comandos atuais: [README](../README.md#verificação). Escopo entregue: [arquitetura](../ARCHITECTURE.md).

## Containers — 2026-10-22

Registro migrado do README: Podman rootless/Docker Compose, build com Bun 1.3.14 e lockfile congelado, migration dentro do container e API publicada em `127.0.0.1:3109` (`APP_PORT=3109`). Smoke HTTP observou criação 201, consulta 200, oito duplicatas concorrentes com 409 e dinheiro numérico com 400. Saldo persistido e soma SQL do ledger: `1234567890123456.78 BRL`, versão 1, um CREDIT, uma OPENING processada e dois eventos pendentes. Abertura zero sem auditoria.

## Ledger — 2026-10-22

Registro migrado do README: `bun run typecheck` e `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: 77 testes aprovados, zero falhas, 324 assertions em sete arquivos. Arquivo isolado de ledger: três testes, 68 assertions; quatro páginas, empates de timestamps, microssegundos e inserções entre consultas.

Smoke separado: `bun run start`, porta 3113, PostgreSQL de testes em container. Criação 201; ledger 200 com `9007199254740993.01 BRL` exato; limite inválido 400; wallet ausente 404. Migration de índice `20261022000300` em up/down/up. Nest Boost MCP confirmou GET `/wallets/:walletId/ledger` em processo novo; processo anterior mantinha snapshot antigo das rotas.

Essas evidências não comprovam apostas, SQS, publishers ou concorrência financeira entre múltiplas instâncias.

## Documentação e Postman — 2026-10-22

Nesta reorganização, migrations foram executadas com `DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun run migration:up`. API iniciada no host com `PORT=3117 bun run start`, usando esse PostgreSQL real em container.

Smoke HTTP direto confirmou abertura positiva e zero (201), consultas e ledger (200), duplicata (409), dinheiro numérico, limite 101, cursor inválido e UUID inválido (400), wallet ausente (404). Valor `9007199254740993.01 BRL` permaneceu exato no saldo e no CREDIT; wallet zero retornou ledger vazio.

Os 19 requests da collection e seus 19 blocos de verificação foram executados em ordem contra essa API por harness temporário em memória, com substituição de variáveis, scripts pre-request/post-response e asserções. Todos passaram: IDs separados, duplicata sem alteração de saldo, crédito exato, histórico vazio e códigos de erro esperados. Não foi executado Postman GUI, Collection Runner ou runtime oficial; importação visual não foi verificada.

Collection validada contra schema oficial Postman v2.1 com `jsonschema` em ambiente temporário via `uv`, sem dependência adicionada ao projeto. JSON do environment parseado; destinos locais dos links em 16 documentos conferidos. Nenhum teste de aplicação ou build foi reexecutado nesta mudança documental.

Dados append-only gerados pelo smoke permanecem no banco descartável de testes; não houve limpeza destrutiva. Processo HTTP próprio foi encerrado após verificação; containers preexistentes preservados.

## Organização modular NestJS — 2026-10-22

Integração `integration/organizacao-modular-nest`, baseline `a895d9fb5791006417bd171dd825a9a22a55bb0d`. Implementação isolada em worktree e integrada por fast-forward do commit `3a9e0ba`. Sem alteração de lógica financeira, schema ou dependências; testes existentes tiveram apenas imports atualizados.

Antes da reorganização, `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/wallet-http.test.ts tests/integration/ledger-http.test.ts`: typecheck aprovado, 11 testes/132 assertions aprovados. Após integração, o mesmo comando repetiu esse resultado. Verificação final `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: 77 testes aprovados, zero falhas, 324 assertions em sete arquivos. Nenhum teste de diretórios, wiring ou snapshot de DI adicionado.

Nest Boost MCP executado em processos novos antes e depois, usando `application_info`, `list_routes` e `module_graph`, sem `evaluate`. Antes: um módulo com três rotas. Depois: preview → AppModule → WalletsModule → PersistenceModule; três rotas preservadas, controller pertencente a WalletsModule e token MikroORM exportado pela persistência. Preview completou sem executar a factory de conexão ao banco.
A inspeção adicional foi concluída com `DATABASE_URL=postgresql://unreachable:unreachable@127.0.0.1:1/unreachable`, confirmando que rotas e grafo em preview não dependem de PostgreSQL alcançável.

Smoke separado no host: `DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test PORT=3121 bun run start`. Criação positiva e zero 201, consulta de wallet e ledger 200, duplicata 409 `WALLET_ALREADY_EXISTS`, limite 101 retornando 400 `INVALID_LEDGER_QUERY`, wallet ausente 404 `WALLET_NOT_FOUND`. Dinheiro `9007199254740993.01 BRL` exato; reenvio preservou resposta da wallet e único lançamento, abertura zero apresentou histórico vazio. Wallet positiva: `f152e931-5ac3-46a9-af5c-50119879b626`. Segundo startup deliberado na mesma porta encerrou com código 1 e `EADDRINUSE`, sem permanecer em execução; isso exercita falha após inicialização do ORM, não toda possível falha interna de Nest.

Imagem reconstruída com `podman compose build app`: Bun 1.3.14, dependências de produção e lockfile congelado. `podman compose run --rm app bun run migration:up` aplicou somente migration 003 já existente que estava pendente no banco local; nenhuma migration nova foi criada. `APP_PORT=3122 podman compose up -d app` iniciou a imagem, e o mesmo smoke HTTP passou via porta publicada, inclusive duplicata sem alteração de saldo/ledger e dinheiro exato. Wallet positiva no banco local: `ca2acf5a-d80c-4ff1-a178-2da09d592c8d`.

Processo próprio do host encerrado e container da aplicação parado com `podman compose stop app`; listeners 3121 e 3122 deixaram de responder. Bancos e demais processos preexistentes preservados; dados append-only dos smokes não foram excluídos. Harness temporário existiu somente em memória. Evidências não ampliam garantias para apostas, SQS ou múltiplas instâncias financeiras.

Dois agentes revisaram o diff contra o baseline de forma independente: Standards encontrou zero violações e zero smells materiais; Spec teve zero achados após conferir as 20 histórias e decisões. As revisões foram estáticas, sem repetição de builds ou testes.
