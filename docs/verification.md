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

## Consulta de transação — 2026-10-23

Ticket 07, baseline `e78c01843f8fd807f65e86a6fdd8c33234610b80`. Bun 1.3.14, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6 em container Podman preexistente na porta 55433. Docker CLI indisponível; `podman ps` confirmou banco saudável. Sem dependência ou migration nova.

Seam confirmado: HTTP com PostgreSQL real, sem testes diretos de serviço. Primeiro teste falhou com 404 na consulta por ID; após implementação, passou. Arquivo focal `tests/integration/transaction-query-http.test.ts`: três testes, 58 assertions, zero falhas. Cobre valor acima de Number.MAX_SAFE_INTEGER, saldo observado preservado após outra aposta, consulta sem alteração de wallet/ledger, sucesso e rejeição após recriar aplicação/pool, isolamento por provider, caixa, caracteres codificados e erros 400/404.

Smoke independente: `bun /tmp/transaction-query-smoke.ts`, harness temporário removido após uso. Iniciou `bun src/main.ts` na porta 3137 com banco de testes, abriu wallet de `100.00 BRL`, processou BET `80.00` e rejeitou outra `80.00`. Ambas as rotas retornaram 200 com resultados iguais antes e depois de SIGTERM, saída do processo e novo startup. Saldo final `20.00 BRL`; reconciliação consistente, diferença zero e dois lançamentos. UUID inválido retornou 400; inexistente retornou 404 `TRANSACTION_NOT_FOUND`. Wallet `d7b8cd35-0a55-4a33-bfb9-ffd31e9f399d`; transações `da91a57f-c761-46c1-8b56-cd82af2818a1` e `f7afc814-201e-49bf-91c5-2d749210eab4`. Processo próprio encerrado; auditoria e containers preservados.

Verificação final: `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: typecheck aprovado, 93 testes em dez arquivos, 571 assertions, zero falhas. Suíte completa executada uma vez ao final; arquivo focal e typecheck executados nos incrementos.

Nest Boost inspecionou rotas antes e depois da alteração, mas servidor persistente continuou exibindo somente POST de transação; snapshot desatualizado reportado à ferramenta. HTTP real comprovou as duas GETs; não se atribui essa prova ao MCP. Context7 confirmou `@Get`, `@Param` e status 200 na documentação oficial do Nest. Nenhum `evaluate`, rebuild de imagem ou verificação visual Postman.

Documentação mantém registro técnico para desenvolvedor/avaliador. humanizer-pt-br e no-ai-slop aplicadas: descrição inicial passou a incluir consulta de transação; contratos e exemplos usam nomes reais, sem qualificadores promocionais. Decisão fica na arquitetura; cobertura aponta para este registro, sem repetir resultados.

Code-review em dois agentes independentes contra baseline: Standards sem violações documentadas ou smells materiais; Spec sem lacunas ou erros acionáveis. Ambos incluíram o teste novo ainda untracked e não repetiram checks.

## Concorrência entre processos — 2026-10-23

Ticket 08, baseline `6c03268984f13568db694cfb0e3ea711bd3f38cd`. Bun 1.3.14, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6 no container Podman preexistente, porta 55433. Sem dependência, migration ou mudança no código financeiro.

Seams acordados: HTTP, PostgreSQL real e caso de uso. Novo `tests/integration/wallet-concurrency.test.ts` inicia três processos com aplicações Nest e pools próprios. O primeiro incremento falhou por ausência da fixture; após adicioná-la, disputa e replay passaram. A barreira inicial falhou por contar somente bloqueios diretamente ligados à transação de controle; passou ao observar processos bloqueados, inclusive esperas enfileiradas. Não foi necessário mudar a estratégia transacional da aplicação.

Comando focal: `TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test tests/integration/wallet-concurrency.test.ts`. Resultado final: três testes, 215 assertions, zero falhas. Typecheck executado nos incrementos. Cenários:

- Duas BET de `80.00` sobre `100.00`: uma PROCESSED, outra REJECTED/INSUFFICIENT_FUNDS, saldo `20.00`, versão 2 e um débito. Três processos repetem ambos os resultados sem novo efeito.
- Mesma BET de `25.00` enviada 50 vezes, metade HTTP e metade por IPC ao caso de uso: um resultado original e 49 replays iguais, uma transação BET, um débito e dois eventos. Antes de liberar a wallet, a barreira observou três processos distintos esperando locks no PostgreSQL.
- Com uma wallet bloqueada e BET pendente, outras duas wallets confirmam BET nos demais processos antes da liberação. Todas terminam em `20.00`, um débito e reconciliação consistente.

Todos os cenários consultam reconciliação pelas três APIs e comparam valores literais de saldo armazenado/reconstruído, diferença zero e quantidade de lançamentos. Consultas SQL conferem débitos; fixtures não removem constraints nem alteram histórico financeiro.

Smoke separado, harness em memória via Bun: três processos de `bun src/main.ts`, PIDs 2717496/2717497/2717498, portas dinâmicas. Wallet `6088e567-77a1-4ec6-948e-11f413e0f32b`; duas BET simultâneas retornaram 201/422, terceiro processo repetiu sucesso e rejeição com resposta original. Reconciliação retornou saldo armazenado e calculado `20.00 BRL`, diferença zero, dois lançamentos. Os três processos encerraram por SIGTERM com código 0; containers e auditoria preservados.

Verificação final: `bun run typecheck && TEST_DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55433/wagering_test bun test`: 96 testes em 11 arquivos, 786 assertions, zero falhas. Suíte completa executada uma vez ao final.

Nest Boost `application_info` confirmou Nest 11.1.16 e MikroORM 6.6.8; não foi usado para atribuir prova de concorrência. PostgreSQL 17 documentou escopo/duração de locks de linha; Context7 forneceu API IPC do Bun, exercitada na versão instalada. Sem `evaluate`, SQS, publishers, morte entre commit/ack ou benchmark.

Documentação mantém voz técnica para desenvolvedor/avaliador. humanizer-pt-br e no-ai-slop aplicadas: "prova com três processos pertence ao ticket 08" foi substituído pelo comando executável e seus limites; "três processos financeiros [...] pendentes" foi atualizado para separar BET validada de operações futuras. Sem alterar garantias para fluxos não exercitados.

Code-review contra baseline em dois agentes independentes, incluindo teste e fixture novos: Standards sem violações documentadas ou smells materiais; Spec sem lacunas nos seis critérios do ticket. Revisão somente leitura, sem repetir checks.

## Collection Postman atualizada — 2026-10-23

Collection ampliada de 19 para 36 requests. Preservados abertura, ledger e erros; adicionados BET processada/rejeitada, replay dos dois resultados, conflito de payload, consulta por ID interno e provider/ID externo, reconciliação e roteiro manual com três instâncias. Environment inclui URLs independentes para cada instância; identidades e resultados dos novos fluxos usam variáveis próprias.

Smoke executado com Newman 6.2.3, obtido por `npx --yes newman`, sem adicionar dependência ao projeto. Harness em memória iniciou três processos de `bun src/main.ts` com portas dinâmicas e PostgreSQL real de testes em container na porta 55433. Executou a collection inteira com `-e docs/postman/local.postman_environment.json` e `--env-var` para `baseUrl` e as três URLs de instância.

Resultado: 36 requests, 36 scripts de resposta, sete scripts de preparação e 37 assertions, zero falhas, saída 0. BET retornou 201, rejeição 422, replays preservaram resultado, payload divergente retornou 409, consultas retornaram 200 e ledger/reconciliação confirmaram saldo `20.00 BRL` e único débito. Três APIs encerradas por SIGTERM com saída 0. Auditoria preservada; nenhum arquivo temporário ou dependência nova no repositório.

Limite: Newman executou requests em sequência, inclusive a pasta de três instâncias. Essa execução valida os requests e scripts exportados, não simultaneidade. O guia ensina a segurar lock em sessão SQL para envio manual em duas abas; esse roteiro gráfico não foi executado nesta atualização. A collection não envia 50 requests em paralelo; a prova permanece no teste do ticket 08. Interface gráfica do Postman não inspecionada. Sem mudança TypeScript, migrations ou código financeiro.

Guia mantém registro técnico para desenvolvedor, com passos de Send e resultados concretos. Removida afirmação desatualizada de que OPENING era a única escrita disponível. Referência consultada via Context7: [execução de collection com Newman](https://learning.postman.com/docs/reference/newman-cli/installing-running-newman).

## Ambiente local com .env — 2026-10-23

O novo `.env.example` separa as URLs locais de desenvolvimento e testes e define `HOST=127.0.0.1` e `PORT=3000`. No `.env` existente, mantivemos `DATABASE_URL`, preenchemos `TEST_DATABASE_URL`, que estava vazia, e adicionamos HOST/PORT. O Git ignora `.env` e variantes; a exceção permite versionar apenas `.env.example`. Docker já excluía esses arquivos do contexto da imagem. A configuração interna do Compose não mudou: a API no container continua usando sua própria URL.

Bun 1.3.14 já lê `.env`; não adicionamos dependência nem loader. Referência consultada via Context7: [variáveis de ambiente no Bun](https://bun.sh/docs/runtime/environment-variables). README e guia Postman agora usam o arquivo local. As sobrescritas explícitas ficaram nos comandos de portas alternativas e reversão no banco descartável. Código financeiro e schema não mudaram.

Antes dos comandos, removemos DATABASE_URL, TEST_DATABASE_URL, HOST e PORT do ambiente herdado com `env -u`. `bun run migration:up` concluiu no banco de desenvolvimento. O teste focal de concorrência passou com três testes e 215 assertions; `bun run typecheck` também passou. A suíte completa, executada com `env -u DATABASE_URL -u TEST_DATABASE_URL -u HOST -u PORT bun test`, passou com 96 testes, 786 assertions e zero falhas.

No smoke, iniciamos `bun run start` sem as quatro variáveis herdadas. A API anunciou `http://127.0.0.1:3000`. A abertura da wallet `49f01bc6-645a-4933-bb7c-3e7078f4971e` retornou 201 com saldo `0.00 BRL`; a consulta retornou 200. Encerramos o processo por SIGTERM, com saída 0, e preservamos dados e containers preexistentes. `git check-ignore` confirmou que `.env`, `.env.local` e `.env.test` ficam ignorados, enquanto `.env.example` pode entrar no repositório.

## WIN por HTTP — 2026-10-23

Ticket 09, baseline `22893b9f9e15fde5477af97f562f4ef588af34b5`, branch main por solicitação de commit na branch atual. Bun 1.3.14, NestJS 11.1.16, MikroORM 6.6.8 e PostgreSQL 17.6 no container Podman preexistente, porta 55433. Docker CLI ausente; banco saudável confirmado por `podman ps` e versão por `psql`. Nenhuma dependência adicionada.

Seams mantidos: HTTP/PostgreSQL real e domínio financeiro. Primeiro tracer, `bun test tests/integration/win-http.test.ts`, falhou com 400 em vez de 201. Depois da implementação, o mesmo crédito de `0.01` sobre `9007199254740993.01` expôs saldo materializado antigo, embora a resposta fosse correta. `DecimalType.compareValues` instalado convertia strings para `number`. Mapeamentos passaram a usar instâncias de StringType com coluna SQL numeric; o teste passou sem reduzir valor ou precisão. Declarações por string e pela classe StringType ainda permitiam a inferência de DecimalType, portanto foram descartadas.

Typecheck intermediário encontrou tipos de resposta estreitos nos testes e `PromiseWithResolvers` não disponível na configuração atual; corrigidos com formato de resposta e `ReturnType<typeof Promise.withResolvers<…>>`. Uma assertion exigia `kind` também em BalanceChanged, fora do contrato; passou a verificar `kind` somente no evento Processed, preservando as verificações de saldo e versão do BalanceChanged.

Verificações focais executadas:

- `bun test tests/integration/win-http.test.ts`: 15 testes, 234 assertions, zero falhas. Crédito exato, referência BET com prêmio/jogo distintos, isolamento por provider, conflitos de wallet/moeda/rodada, referência rejeitada ou de outro kind, pendência persistida, payload inválido, replay com saldo original, conflitos de chave/identidade, duplicatas concorrentes em duas aplicações/pools, rollback por falha induzida na outbox e checks/FK de referência.
- `bun test tests/domain/wager-transaction.test.ts tests/domain/wallet.test.ts`: 34 testes, 123 assertions, zero falhas. Crédito exato e sem mutação da wallet anterior; validações de referência, moeda, valor e transições terminais.
- `bun run typecheck && bun test`: typecheck aprovado; suíte completa executada uma vez ao final, 139 testes em 13 arquivos, 1128 assertions, zero falhas. Inclui a prova BET preexistente em três processos.

Smoke independente executado com `bun /tmp/wagering-win-smoke.ts`, harness temporário. Iniciou `bun src/main.ts` em porta dinâmica com banco de testes e percorreu abertura `100.00`, BET `25.00`, WIN referenciada `40.00` e WIN independente `5.00`. Referência incompatível retornou 422, referência inexistente retornou 202 sem crédito, moeda incompatível retornou 400 e referência alterada sob mesma chave retornou 409. Após SIGTERM e saída 0, outro processo reproduziu WIN com saldo original `115.00` e pendência com resposta original. Wallet `10a39867-be96-4b45-905f-1df96a335504`: saldo final e reconstruído `120.00 BRL`, versão 4, quatro lançamentos, diferença `0.00` e `consistent: true`. Segundo processo também encerrou com código 0.

Smoke de migration, `bun /tmp/wagering-win-migration-smoke.ts`, criou banco isolado `win_migration_85935072d5e84f1ca2671e000b289ba3_test`, aplicou todas as migrations e executou down/up da migration WIN sem histórico. Depois creditou WIN de `1.00` por HTTP e confirmou que down recusou histórico WIN, mantendo saldo `1.00` e versão 2. Aplicação/pool fechados e somente esse banco temporário removido. Auditoria e containers preexistentes preservados.

Nest Boost confirmou POST `/wagering/transactions`; nenhum `evaluate`. Context7 e [documentação oficial MikroORM 6.6](https://mikro-orm.io/docs/6.6/transactions) consultados para transação/lock; código instalado de DecimalType e MetadataDiscovery explicou a comparação com perda de precisão. Busca semântica indisponível por erro do provedor; pesquisa textual substituiu. LSP indisponível.

Documentação mantém registro técnico em PT-BR para desenvolvedor/avaliador. humanizer-pt-br e no-ai-slop aplicadas: "WIN pendente" foi trocado por crédito, referência e worker explicitamente separados; "somente BET" foi atualizado sem prometer LOSS ou SQS. Decisões ficam na arquitetura, comandos no README e resultados neste registro. Sem linguagem promocional, fecho genérico ou duplicação dos resultados na cobertura.

Limites: pendência WIN não resolve nem expira automaticamente; tickets 13/14 continuam responsáveis pelo worker/backoff/TTL. Não houve SQS, publicação, crash forçado entre commit/ack, rebuild da imagem ou verificação gráfica/Postman. Duplicatas WIN foram exercitadas em duas aplicações no mesmo processo; prova multiprocesso do teste existente é de BET.

Code-review contra baseline em dois agentes independentes: Standards sem violações documentadas ou smells acionáveis; Spec sem requisitos do ticket ausentes, escopo extra ou implementação incorreta identificada. Revisão incluiu arquivos novos e rename do DTO, sem repetir checks. Harnesses temporários removidos. Cobertura, índice de decisões, estado do projeto e ticket local atualizados; caminhos ignorados não foram incluídos à força no commit.
