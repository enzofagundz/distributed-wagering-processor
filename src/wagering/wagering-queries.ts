import { MikroORM } from "@mikro-orm/postgresql";
import { DomainError } from "../domain/money";
import { wagerTransactionSchema } from "../persistence/wager-transaction-record";

export class WageringQueries {
  constructor(private readonly orm: MikroORM) {}

  async get(
    identity:
      | { id: string }
      | { providerId: string; externalTransactionId: string },
  ) {
    const record = await this.orm.em
      .fork()
      .findOne(wagerTransactionSchema, identity);
    if (!record) throw new DomainError("TRANSACTION_NOT_FOUND");
    return {
      transactionId: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: { amount: record.amount, currency: record.currency },
      status: record.status,
      ...(record.referenceExternalTransactionId == null
        ? {}
        : {
            referenceExternalTransactionId:
              record.referenceExternalTransactionId,
          }),
      ...(record.referenceTransactionId == null
        ? {}
        : { referenceTransactionId: record.referenceTransactionId }),
      ...(record.observedBalance == null
        ? {}
        : {
            balance: {
              amount: record.observedBalance,
              currency: record.currency,
            },
          }),
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
      createdAt: record.createdAt,
      processedAt: record.processedAt,
    };
  }
}
