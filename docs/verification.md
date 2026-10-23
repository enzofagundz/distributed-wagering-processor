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

## Reconciliação — 2026-10-22

Ticket 04, baseline `4d45f6c939d9bbd0f44119724651cbe922f99ae8`. Bun 1.3.14 e PostgreSQL 17.6 nos containers Podman preexistentes; Docker CLI indisponível, `podman compose ps` confirmou bancos nas portas 55432/55433. Nenhuma dependência ou migration nova.

TDD HTTP/PostgreSQL acordado: primeiro teste falhou com 404 (rota ausente); passou após implementação. Teste divergente falhou com 400 para diferença negativa; comparação exata da diferença SQL eliminou uso indevido do parser monetário de entrada. Execução final focal: `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/reconciliation-http.test.ts`: 3 testes, 28 assertions, zero falhas. Typecheck aprovado antes e depois dessas slices.

`bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: 80 testes em oito arquivos, 352 assertions, zero falhas. Integração cria/remove banco exclusivo; concorrência usa transação SQL independente com saldo alterado e ledger ainda não inserido, lê estado anterior sem bloqueio e estado novo após commit, para CREDIT e DEBIT. Não comprova movimentações de apostas ou três instâncias.

Smoke separado do teste: `DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55432/wagering PORT=3134 bun run start`. Harness temporário em memória criou wallet com `9007199254740993.01 BRL` (201), reconciliou (200, saldo exato, diferença zero, consistent true, um lançamento) e leu /metrics (200, contador zero). Wallet `cc7fa779-ee06-474f-ac71-6ee01b5381f7`; auditoria preservada no banco local.

Nest Boost: module_graph inspecionou composição existente; servidor MCP persistente manteve três rotas antigas. Processo MCP novo iniciado com `bun run nest-boost mcp` confirmou cinco rotas, incluindo POST reconciliação e GET /metrics; encerrado com SIGTERM após resposta. evaluate não usado. Inspeção não substituiu smoke HTTP. Sem verificação visual do Postman ou rebuild da imagem nesta entrega.

Processo HTTP próprio da porta 3134 encerrado após smoke; bancos e auditoria preservados.

Revisão independente do diff contra baseline: Standards encontrou zero violações e zero smells materiais; Spec encontrou zero achados acionáveis. Agentes fizeram revisão estática, sem reexecutar checks. Commit em main autorizado explicitamente pelo usuário.

## BET por HTTP — 2026-10-22

Ticket 05, baseline `56881ac43d306f1998b84398543d455ccf3362d7`. Bun 1.3.14, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6 em container Podman preexistente na porta 55433. Docker CLI ausente; `podman ps` confirmou os bancos. Nenhuma dependência nova.

Seam acordado: HTTP com PostgreSQL real; SQL verifica auditoria, atomicidade e unicidades exigidas pelo ticket. Primeiro red: POST ausente retornou 404. Green inicial: um teste de débito exato aprovado. Segundo red: identificador com NUL chegou ao driver e produziu 503 em vez de 400; guarda compartilhada de identidade passou a rejeitar controles antes de escrever. Typecheck encontrou opcionais incompatíveis com `exactOptionalPropertyTypes`; tipos corrigidos, sem afrouxar configuração.

`TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/bet-http.test.ts`: sete testes, 126 assertions, zero falhas. Cobertura: valor além de Number.MAX_SAFE_INTEGER, saldo exato/insuficiente, versão, eventos com MoneyProps, contrato inválido e JSON malformado, player/moeda divergentes, unicidades persistentes e rollback integral por falha de outbox. Duas APIs com instâncias de ORM/pools independentes disputaram `100.00` com duas BET de `80.00`: uma 201, outra 422, saldo `20.00`, um DEBIT e reconciliação consistente. Não foram três processos.

Falha induzida no evento WalletBalanceChanged retornou 500 genérico e desfez débito, transação, ledger e novos eventos; reenvio após remover trigger confirmou uma vez. Falha ao persistir evento de rejeição também desfez a transação; código SQLSTATE 55P03 induzido retornou 503, e unicidade inesperada 23505 retornou 500, não conflito de aposta. Isso verifica tradução e rollback, não queda real de rede ou timeout de lock.

`bun run typecheck` aprovado. Execução focal com BET, ledger e reconciliação antes da inclusão do caso de JSON malformado: 13 testes, 220 assertions, zero falhas. Fixtures sintéticas existentes passaram a remover índice parcial de OPENING somente nos seus bancos exclusivos.

Smoke separado: `DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test PORT=3135 bun run start`. Harness em memória abriu wallet de `100.00` (201), processou BET `80.00` (201/PROCESSED), rejeitou outra `80.00` (422/INSUFFICIENT_FUNDS), bloqueou reenvio (409/TRANSACTION_ALREADY_EXISTS) e confirmou saldo `20.00`, versão 2, dois lançamentos e reconciliação consistente. Wallet `8b85a65f-2687-4e1a-94f7-00e2ba70c232`; auditoria preservada. Processo próprio encerrado; containers preexistentes mantidos.

Migration 004 exercitada em bancos temporários criados e removidos por harness em memória: up/down/up preservou OPENING legado. Down com BET foi recusado com SQLSTATE 55000 antes de remover schema; saldo observado da BET permaneceu acessível. Primeiro harness não tratava o wrapper MigrationError e encerrou com erro ao receber a recusa esperada; segundo cenário inspecionou `cause.code` e comprovou preservação, com saída 0. Nenhuma mudança de produção foi necessária.

Nest Boost: servidor MCP persistente ainda exibia três rotas antigas. Processo novo via `bun run nest-boost mcp`, com DATABASE_URL deliberadamente inalcançável, confirmou seis rotas, incluindo POST `/wagering/transactions`, e WageringModule com WageringController/WageringService. `application_info`, `list_routes` e `module_graph` executados; `evaluate` não usado. Cliente SDK direto não carregou por dependência ajv ausente; inspeção concluída pelo protocolo stdio, sem instalar pacote. Processo MCP próprio encerrado.

Documentação manteve registro técnico em PT-BR, sem linguagem promocional ou fechos genéricos. Mudanças editoriais substituem afirmações desatualizadas de "apostas pendentes" pelo fluxo entregue e preservam limites de replay, mensageria e autenticação; detalhes ficam na arquitetura e resultados neste registro.

Verificação final: `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: typecheck aprovado, 87 testes em nove arquivos, 478 assertions e zero falhas. Suíte completa executada uma vez ao final da implementação.

Revisão code-review em dois agentes independentes contra baseline: Standards encontrou zero violações e zero smells materiais; Spec encontrou zero achados acionáveis. Revisões estáticas, sem repetir checks. Semântica de replay/hash e cenários de SQS/três processos continuam fora deste ticket.

## Persistência sem atalho deprecated — 2026-10-22

Sete chamadas nos serviços de wallet e BET passaram a usar `await em.persist(...).flush()`, conforme a recomendação da declaração instalada do MikroORM. Mantidos os mesmos argumentos, awaits, pontos de flush e fronteiras de `transactional`; nenhuma mudança no contrato HTTP ou schema. Arquitetura e ADR-0002 atualizados.

`bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: typecheck aprovado, 87 testes em nove arquivos, 478 assertions e zero falhas. Inclui abertura zero/positiva, débito/rejeição, concorrência, conflitos e rollback por falha induzida na outbox.

Smoke independente na porta 3136, PostgreSQL real de testes na porta 55433: abertura 201, BET 201/PROCESSED, insuficiência 422/REJECTED e reenvio 409. Saldo final `20.00 BRL`, versão 2, um CREDIT e um DEBIT; reconciliação consistente com diferença zero. Wallet `51041d3f-fc25-414f-83e8-e2093ed1165d`. Harness reutilizado em memória, sem novo arquivo ou dependência. Processo HTTP próprio encerrado; auditoria e containers preexistentes preservados.

## Idempotência de BET — 2026-10-23

Ticket 06, baseline `3f64aa52bf485813d37714e0c2ac0a7b5fa1940c`. Bun 1.3.14, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6 em container Podman preexistente, porta 55433. Docker CLI ausente; banco real acessível. Nenhuma dependência adicionada.

Seam confirmado pelo usuário: HTTP com PostgreSQL real, com SQL para invariantes de auditoria. Red: teste de replay após outra BET recebeu 409 em vez de 201. Green: resultado original preservado, payload divergente em 409 `IDEMPOTENCY_CONFLICT`, outra chave para identidade externa em 409 `TRANSACTION_ALREADY_EXISTS`. Typecheck intermediário encontrou propriedade `money` repetida na construção do payload de teste; corrigida sem alterar regra financeira.

Arquivo `tests/integration/bet-http.test.ts`: dez testes e 161 assertions aprovados. Inclui nove requests concorrentes em três aplicações Nest/pools independentes dentro do mesmo processo, exatamente uma resposta inicial e oito replays, um débito e dois eventos financeiros. Fecha uma aplicação e seu pool, recria ambos e repete resultado. Rejeição mantém 422 e saldo original após outra BET, sem segundo evento. Chave global conflita entre wallets/providers; identidade externa não permite novo efeito em outra wallet. Validação, rollback integral e códigos 503/500 continuam exercitados pelos cenários existentes.

Smoke separado executado com `bun /tmp/bet-idempotency-smoke.ts`, harness temporário removido após uso. Iniciou API real por `bun src/main.ts` na porta 3136 com banco dedicado de testes; abriu wallet (201), processou BET (201), encerrou processo por SIGTERM e aguardou saída. Com API parada, migration 005 fez down/up preservando histórico e preenchendo hash. Novo processo devolveu replay (201), conflito de payload (409) e reconciliação (200) com saldo `75.00 BRL`, diferença zero e dois lançamentos. Payload continha aspas, barra invertida, acento e emoji para comparar escaping SQL do backfill com JSON do runtime. Wallet `9599dcf5-0bcd-4003-8ad3-c86fa7f8d4dd`; auditoria preservada e processo próprio encerrado.

Verificação final: `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: typecheck aprovado; 90 testes em nove arquivos, 513 assertions, zero falhas. Suíte completa executada uma vez após implementação; integrações aplicaram migration 005 também em bancos isolados.

Nest Boost MCP confirmou POST `/wagering/transactions` em `WageringController.submit`; evaluate não usado. Consulta Context7 e leitura da [documentação MikroORM 6.6](https://mikro-orm.io/docs/6.6/transactions) orientaram recuperação com EntityManager novo após rollback. Busca semântica indisponível por falha do provedor; pesquisa textual substituiu. LSP não disponível; typecheck executado via TypeScript instalado.

Documentação mantém registro técnico em PT-BR para desenvolvedor/avaliador. Aplicadas humanizer-pt-br e no-ai-slop: trechos de "replay pendente" foram substituídos por comportamento observável, sem linguagem promocional nem fechos genéricos; algoritmo e política ficam na arquitetura, evidências neste registro.

Limites: não houve três processos simultâneos, 50 reenvios, broker, ack ou crash forçado entre commit e resposta. Esses cenários seguem nos tickets de concorrência/mensageria. BET é síncrona; 202 é política reservada para pendências futuras, não comportamento implementado ou testado neste ticket. Rebuild de imagem e interface Postman não executados.

Revisão code-review contra baseline em dois agentes independentes: Standards sem violações documentadas ou smells materiais; Spec sem lacunas ou erros acionáveis. Incluiu migration nova, que ainda não aparecia em `git diff` por estar untracked. Revisão somente leitura; nenhum check repetido. Arquivos de continuidade, índice de decisões e ticket local foram atualizados sem forçar inclusão de caminhos ignorados.
