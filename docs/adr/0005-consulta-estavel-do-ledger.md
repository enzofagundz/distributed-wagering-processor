# 5. Consulta estável do ledger

## Status

Aceita e adotada. Migra D-005.

## Contexto

O histórico precisa de leitura determinística, sem saltos de `OFFSET` causados por inserções e sem perda dos microssegundos armazenados pelo PostgreSQL. Histórico vazio não deve ser confundido com wallet inexistente, e consultar não deve gerar efeitos financeiros.

## Decisão

`GET /wallets/:walletId/ledger` usa keyset crescente por `(created_at, id)`. UUID é desempate único; índice `(wallet_id, created_at, id)` atende filtro e ordenação. A migration [20261022000300](../../src/persistence/migrations/Migration20261022000300.ts) substitui o índice simples por wallet; `down` restaura o índice anterior sem tocar dados.

Cursor opaco contém o UUID do último lançamento retornado, codificado em base64url canônico. Não é token de autorização nem possui assinatura; cliente não deve interpretá-lo. Servidor aceita somente ID existente na mesma wallet. Trocar cursor por outro lançamento da mesma wallet escolhe outra posição de leitura, sem permitir escrita ou acesso a outra wallet. Não há autenticação neste estágio.

Consulta parametrizada via MikroORM compara tuplas no PostgreSQL e busca timestamp diretamente do lançamento apontado pelo cursor. Não converte esse timestamp em `Date` para retomar página: isso perderia microssegundos e poderia repetir ou omitir linhas. Resposta mantém timestamp textual com offset e dinheiro como string decimal. Busca `limit + 1`, devolve no máximo `limit` e só emite `nextCursor` quando existe outro lançamento.

`LedgerQueryDto`, `@Query` e `ValidationPipe` seguem a convenção HTTP existente: `expectedType` explícito, whitelist estrita e conversão implícita desativada. `limit` é texto canônico de 1 a 100, padrão 50; a conversão explícita para número ocorre somente no tamanho da página, nunca no dinheiro. Query inválida retorna 400 `INVALID_LEDGER_QUERY`; UUID inválido retorna 400 `INVALID_IDENTITY`; wallet ausente retorna 404 `WALLET_NOT_FOUND`, distinto de histórico vazio 200. A consulta não escreve em wallet, ledger, transação ou outbox.

## Consequências

`OFFSET` foi descartado porque inserções antes da posição lida deslocam páginas. Keyset preserva ordem dos lançamentos existentes, inclusive empates e microssegundos, mas não mantém snapshot entre requests: novas linhas posteriores ao cursor podem aparecer; linhas inseridas retroativamente antes dele aparecem somente em nova travessia. Ledger append-only mantém a âncora válida; reiniciar processo não perde posição porque ela vive no PostgreSQL.

Os testes existentes usam HTTP real e PostgreSQL em container, com banco exclusivo por execução. Somente nessa fixture remove-se a unicidade de OPENING por wallet para preparar múltiplos lançamentos, pois o schema atual restringe transações a OPENING. Trigger de imutabilidade, aritmética, FKs e unicidade de lançamento/transação continuam ativos. O histórico sintético verifica leitura, não implementação de apostas nem consistência financeira de movimentações futuras. O usuário local de teste precisa criar banco; teardown remove o banco exclusivo. Evidências históricas, inclusive inspeção de rota e DI por Nest Boost em processo novo, estão em [verificação do ledger](../verification.md#ledger--2026-10-22); não foram reexecutadas nesta migração documental.

Fontes: [consulta no WalletService](../../src/wallet-service.ts), [LedgerQueryDto](../../src/ledger-query.dto.ts), [teste HTTP](../../tests/integration/ledger-http.test.ts). Referências: [NestJS validation](https://docs.nestjs.com/techniques/validation), [MikroORM 6.6 migrations](https://mikro-orm.io/docs/6.6/migrations). Limites de segurança: [ADR-0004](0004-contrato-http-e-ambiente-reproduzivel.md).
