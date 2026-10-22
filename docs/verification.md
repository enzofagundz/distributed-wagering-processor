# Evidências de verificação

Registros históricos, não garantia de que comandos foram reexecutados na sua máquina. Setup e comandos atuais: [README](../README.md#verificação). Escopo entregue: [arquitetura](../ARCHITECTURE.md).

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
