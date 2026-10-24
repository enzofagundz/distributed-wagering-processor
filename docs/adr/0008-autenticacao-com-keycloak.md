# 8. Autenticação com Keycloak

## Status

Aceita. Ticket 27, seção 2 do enunciado.

## Contexto

O enunciado aceita omitir autenticação, mas, se implementada, exige IdP externo, não autenticação artesanal. Health fica aberto; SQS é canal interno confiável, e a identidade do provedor na mensagem continua sujeita às validações de domínio. Os chamadores HTTP são provedores, sistemas sem interação humana.

## Decisão

Keycloak sobe no Docker Compose com realm importado de JSON versionado. Cada provedor é um client OAuth2 `client_credentials`; o token carrega a claim `providerId`. Zitadel foi descartado por ter setup menos documentado para NestJS.

A API valida JWT localmente com `@nestjs/passport`, `passport-jwt` e `jwks-rsa`: assinatura pelas chaves JWKS do realm, `iss`, `aud` e `exp`. Introspecção por request foi descartada para não colocar latência e disponibilidade do IdP no caminho financeiro. Consequência: revogação só vale ao expirar o token.

Um guard global protege todas as rotas HTTP, exceto health (`@Public()`). Não há autorização por scope: token válido basta. Quando o `providerId` do token difere do payload, a API responde 403 `PROVIDER_IDENTITY_MISMATCH` antes do caso de uso. As validações de provider, player e wallet do domínio permanecem; o guard é camada adicional, não substituta.

Mensagens SQS não carregam token.

## Consequências

Subir o ambiente passa a exigir o container Keycloak. Tokens emitidos continuam válidos até `exp` mesmo após desabilitar o client. Adicionar scopes depois exige só configurar o realm e checar claims no guard.
