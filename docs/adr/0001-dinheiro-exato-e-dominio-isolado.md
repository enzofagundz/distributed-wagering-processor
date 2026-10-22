# 1. Dinheiro exato e domínio isolado

## Status

Aceita e adotada. Migra a decisão D-001.

## Contexto

Valores financeiros precisam preservar centavos sem arredondamento ou perda por ponto flutuante. O domínio não deve depender de NestJS nem ORM. A escala acordada para este projeto é de duas casas decimais, inclusive para moedas reconhecidas pelo runtime.

## Decisão

`Money` representa centavos com `bigint`, sem conversão para `number`. Entrada externa e serialização usam `MoneyProps`: `amount` textual decimal canônico com exatamente duas casas e `currency` reconhecida por `Intl.supportedValuesOf('currency')` do Bun/ICU. Entrada negativa, notação científica, espaços, zeros inteiros excedentes e precisão excedente são rejeitados, nunca arredondados.

Subtração e negação podem produzir valores negativos internos; isso não permite entrada externa negativa. Operações binárias exigem a mesma moeda, inclusive comparação e igualdade. `Money` é congelado em runtime; o modelo preserva a moeda e os testes existentes incluem BRL e USD.

`Wallet` encapsula estado, usa construtor privado, copia datas e distingue `open` de `rehydrate`. Abertura valida identidades UUID e saldo inicial não negativo; reidratação reconstrói saldo e versão persistidos sem reaplicar abertura. O mapeamento de persistência fica fora do domínio, conforme [ADR-0002](0002-persistencia-e-concorrencia-da-abertura.md).

## Consequências

Aritmética inteira nativa é exata na escala adotada e dispensa dependência decimal. A alternativa de biblioteca decimal foi descartada por não ser necessária para a escala fixa.

O conjunto de moedas aceitas acompanha o runtime/ICU; não há conversão cambial. `bigint` não impõe o limite de 28 dígitos inteiros do SQL: a fronteira persistida e sua falha atômica estão no ADR-0002.

Fontes da implementação: [Money](../../src/domain/money.ts), [Wallet](../../src/domain/wallet.ts). Vocabulário: [glossário](../../GLOSSARY.md).
