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
    providerId: "provider-rollback",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: "round",
    gameId: "game",
    kind: "ROLLBACK",
    money: Money.from({ amount: "17.23", currency: "BRL" }),
    referenceExternalTransactionId: "original",
  };
}
function reference(
  transaction: WagerTransaction,
  kind = "BET",
): WagerReference {
  return {
    id: crypto.randomUUID(),
    providerId: transaction.providerId,
    externalTransactionId: "original",
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    currency: "BRL",
    amount: "17.23",
    roundId: transaction.roundId,
    kind,
    status: "PROCESSED",
  };
}

test("ROLLBACK requires external reference and resolves full processed movement before processing", () => {
  const missing = props();
  delete missing.referenceExternalTransactionId;
  expect(() => WagerTransaction.create(missing)).toThrow(
    new DomainError("INVALID_TRANSACTION_PAYLOAD"),
  );
  const transaction = WagerTransaction.create(props());
  expect(() => transaction.markProcessed(at)).toThrow(
    new DomainError("INVALID_TRANSACTION_STATE"),
  );
  const original = reference(transaction);
  transaction.resolveReference(original, at);
  transaction.markProcessed(at);
  expect(transaction.status).toBe("PROCESSED");
  expect(transaction.referenceTransactionId).toBe(original.id);
  expect(() => transaction.resolveReference(undefined, at)).toThrow(
    new DomainError("INVALID_TRANSACTION_STATE"),
  );
});

for (const [kind, direction] of [
  ["BET", "CREDIT"],
  ["WIN", "DEBIT"],
  ["REFUND", "DEBIT"],
] as const) {
  test(`ROLLBACK inverts ${kind} direction`, () => {
    const transaction = WagerTransaction.create(props());
    const original = reference(transaction, kind);
    transaction.resolveReference(original, at);
    expect(transaction.ledgerDirectionFor(original)).toBe(direction);
  });
}

for (const field of [
  "providerId",
  "externalTransactionId",
  "walletId",
  "playerId",
  "currency",
  "roundId",
  "amount",
] as const) {
  test(`ROLLBACK rejects incompatible reference ${field}`, () => {
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
for (const kind of ["LOSS", "ROLLBACK", "OPENING"]) {
  test(`ROLLBACK rejects reference kind ${kind}`, () => {
    const transaction = WagerTransaction.create(props());
    const original = reference(transaction, kind);
    transaction.resolveReference(original, at);
    expect(transaction.failureCode).toBe("REFERENCE_MISMATCH");
    expect(() => transaction.ledgerDirectionFor(original)).toThrow(
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
  test(`ROLLBACK cannot process ${status ?? "missing"} reference`, () => {
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
for (const code of [
  "REFERENCE_ALREADY_ROLLED_BACK",
  "INSUFFICIENT_REVERSAL_FUNDS",
] as const) {
  test(`ROLLBACK persists ${code} as terminal rejection only after resolving reference`, () => {
    const transaction = WagerTransaction.create(props());
    expect(() => transaction.reject(code, at)).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
    transaction.resolveReference(reference(transaction, "WIN"), at);
    transaction.reject(code, at);
    expect(transaction.failureCode).toBe(code);
    expect(transaction.status).toBe("REJECTED");
    expect(() => transaction.markProcessed(at)).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
    expect(() => transaction.markPendingReference()).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
  });
}
