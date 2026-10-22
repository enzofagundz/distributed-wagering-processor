# 6. Organização modular NestJS

## Status

Aceita e adotada.

## Contexto

Controller, módulo raiz e criação da aplicação compartilhavam um arquivo, enquanto DTOs e serviço estavam dispersos na raiz. A separação precisa melhorar a navegação sem modificar contratos HTTP, dinheiro, transações, paginação ou schema. O bootstrap e os testes já fornecem um ORM inicializado e controlam seu encerramento; providers do módulo raiz não são automaticamente visíveis numa funcionalidade importada.

## Decisão

Agrupar `WalletController`, `WalletService`, `OpenWalletDto` e `LedgerQueryDto` em `src/wallets/`. `WalletsModule` registra controller e factory do serviço, mantendo injeção explícita compatível com Bun. `AppModule` compõe a funcionalidade e registra `DomainErrorFilter` uma única vez como `APP_FILTER`; o filtro vive em `src/shared/`, sem módulo compartilhado vazio. `createApplication` fica em arquivo próprio e recebe o ORM do chamador.

Usar módulos dinâmicos nativos: `AppModule.register(orm)` importa `WalletsModule.register(orm)`, que importa `PersistenceModule.register(orm)`. Persistência registra `MikroORM` com `useValue` e exporta esse token; a factory do serviço injeta essa mesma instância. Não há provider global nem configuração mutável de ORM. Imports configurados ficam somente na metadata dinâmica: Nest estende, não substitui, imports declarados estaticamente, e misturá-los duplicaria a funcionalidade.

Nest Boost 0.4.0 aceita somente export de classe como entrada. `PreviewAppModule` importa a mesma composição, sem ORM fornecido, e é o export configurado em `nest-boost.json`. Nesse caso persistência declara a factory de inicialização já usada pelo projeto; o preview nativo não executa factories nem inicializa PostgreSQL. A configuração do banco permanece dentro da factory, não no carregamento do módulo. `evaluate` continua desativado. A entrada de preview não é bootstrap de execução: programa e testes usam exclusivamente `createApplication(orm)`.

O chamador mantém propriedade do ORM. Módulos não fecham pool emprestado nem criam outro quando uma instância foi fornecida. `main.ts` fecha aplicação HTTP antes do pool, inclusive após falha de startup; sinais compartilham uma única promessa de encerramento. `abortOnError: false` permite que falha de criação Nest chegue ao chamador e passe pela limpeza, em vez de encerrar o processo antes dela. Testes mantêm seu próprio teardown. Migrations continuam explícitas.

Controller trata HTTP; serviço coordena domínio e persistência; objetos de domínio preservam invariantes; `EntitySchema` mapeia registros fora do domínio. Acesso direto do serviço ao ORM permanece: não há Repository pass-through, nova interface, camada de casos de uso ou alteração financeira. Nomes existentes foram mantidos; caminhos antigos foram removidos, sem reexports de compatibilidade.

## Consequências

Composição e visibilidade de dependências ficam explícitas, com DTOs próximos de seus consumidores. A organização por funcionalidade é convenção escolhida, não exigência de diretórios do NestJS. Para quem vem de Laravel, controller e serviço continuam separando transporte e coordenação; módulo Nest declara composição/visibilidade e não equivale a um model Eloquent.

As decisões financeiras dos ADRs 0001 a 0005 permanecem vigentes. Os testes existentes continuam no seam HTTP real com PostgreSQL, com somente imports atualizados e assertions financeiras preservadas; não se adicionam testes de wiring ou snapshots de DI. Typecheck, testes, smoke do comando documentado, execução em imagem e inspeção em processo novo devem compor evidência de integração, não ser inferidos da reorganização. Resultados executados ficam em [verificação](../verification.md).

Alternativas descartadas: manter composição misturada ao controller, depender da visibilidade de um provider pai, tornar persistência global, configurar ORM por estado estático, criar um pool por módulo, misturar imports estáticos e dinâmicos da mesma funcionalidade, ou criar repositories que apenas repassem chamadas. A classe adicional de preview atende à restrição real da ferramenta, sem uma segunda árvore de providers.

Fontes: [módulo raiz](../../src/app.module.ts), [criação da aplicação](../../src/create-application.ts), [funcionalidade](../../src/wallets/wallets.module.ts), [persistência](../../src/persistence/persistence.module.ts), [startup](../../src/main.ts), [configuração Nest Boost](../../nest-boost.json). Referências consultadas via Context7: [NestJS modules](https://docs.nestjs.com/modules) e [dynamic modules](https://docs.nestjs.com/fundamentals/dynamic-modules); [custom providers](https://docs.nestjs.com/fundamentals/custom-providers) documenta `useValue`, factories e `inject`. A exigência de classe e uso de `preview: true` foram conferidos na versão instalada de `@mgvdev/nest-boost` 0.4.0; isso não constitui execução de runtime.
