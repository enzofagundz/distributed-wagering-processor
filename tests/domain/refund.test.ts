import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerReference,
} from "../../src/domain/wager-transaction";

const at = new Date("2026-10-23T12:00:00.000Z");
function props(): CreateWagerTransactionProps {
  return {
    id: crypto.randomUUID(),
    providerId: "provider-refund",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: "round",
    gameId: "game",
    kind: "REFUND",
    money: Money.from({ amount: "17.23", currency: "BRL" }),
    referenceExternalTransactionId: "bet",
  };
}
function reference(transaction: WagerTransaction): WagerReference {
  return {
    id: crypto.randomUUID(),
    providerId: transaction.providerId,
    externalTransactionId: "bet",
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    currency: "BRL",
    amount: "17.23",
    roundId: transaction.roundId,
    kind: "BET",
    status: "PROCESSED",
  };
}

test("REFUND requires external reference and resolves an equal processed BET before processing", () => {
  const missing = props();
  delete missing.referenceExternalTransactionId;
  expect(() => WagerTransaction.create(missing)).toThrow(
    new DomainError("INVALID_TRANSACTION_PAYLOAD"),
  );
  const transaction = WagerTransaction.create(props());
  expect(() => transaction.markProcessed(at)).toThrow(
    new DomainError("INVALID_TRANSACTION_STATE"),
  );
  const bet = reference(transaction);
  transaction.resolveReference(bet, at);
  transaction.markProcessed(at);
  expect(transaction.status).toBe("PROCESSED");
  expect(transaction.referenceTransactionId).toBe(bet.id);
  expect(() => transaction.resolveReference(undefined, at)).toThrow(
    new DomainError("INVALID_TRANSACTION_STATE"),
  );
});

for (const field of [
  "providerId",
  "externalTransactionId",
  "walletId",
  "playerId",
  "currency",
  "roundId",
  "kind",
  "amount",
] as const) {
  test(`REFUND rejects incompatible BET ${field}`, () => {
    const transaction = WagerTransaction.create(props());
    transaction.resolveReference(
      {
        ...reference(transaction),
        [field]: field === "amount" ? "17.22" : "different",
      },
      at,
    );
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_MISMATCH");
    expect(() => transaction.markProcessed(at)).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
  });
}

for (const status of [
  undefined,
  "PENDING",
  "PENDING_REFERENCE",
  "REJECTED",
  "FAILED",
]) {
  test(`REFUND ${status ?? "missing"} BET cannot produce a processed reversal`, () => {
    const transaction = WagerTransaction.create(props());
    transaction.resolveReference(
      status === undefined ? undefined : { ...reference(transaction), status },
      at,
    );
    const terminal = status === "REJECTED" || status === "FAILED";
    expect(transaction.status).toBe(
      terminal ? "REJECTED" : "PENDING_REFERENCE",
    );
    expect(transaction.failureCode).toBe(
      terminal ? "REFERENCE_NOT_PROCESSED" : undefined,
    );
    expect(() => transaction.markProcessed(at)).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
  });
}
