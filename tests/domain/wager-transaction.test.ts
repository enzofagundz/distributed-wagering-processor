import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
  type WagerReference,
} from "../../src/domain/wager-transaction";

const at = new Date("2026-10-23T12:00:00.000Z");
function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: crypto.randomUUID(),
    providerId: "provider-win",
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: "round-win",
    gameId: "fortune-chimp",
    kind: "WIN",
    money: Money.from({ amount: "17.23", currency: "BRL" }),
    ...overrides,
  };
}
function reference(
  transaction: WagerTransaction,
  overrides: Partial<WagerReference> = {},
): WagerReference {
  return {
    id: crypto.randomUUID(),
    providerId: transaction.providerId,
    externalTransactionId: transaction.referenceExternalTransactionId!,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    currency: transaction.money.currency,
    amount: "17.23",
    roundId: transaction.roundId,
    kind: "BET",
    status: "PROCESSED",
    ...overrides,
  };
}

test("WIN starts pending and may process without a reference", () => {
  const transaction = WagerTransaction.create(props());
  expect(transaction.kind).toBe("WIN");
  expect(transaction.status).toBe("PENDING");
  expect(transaction.referenceExternalTransactionId).toBeUndefined();
  transaction.markProcessed(at);
  expect(transaction.status).toBe("PROCESSED");
  expect(transaction.processedAt).toEqual(at);
  expect(transaction.referenceTransactionId).toBeUndefined();
  expect(transaction.failureCode).toBeUndefined();
});

test("WIN binds a processed BET identity without requiring equal award or game", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "bet-external" }),
  );
  const bet = reference(transaction);
  transaction.resolveReference(bet, at);
  expect(transaction.referenceTransactionId).toBe(bet.id);
  transaction.markProcessed(at);
  expect(transaction.status).toBe("PROCESSED");
  expect(transaction.money.toJSON()).toEqual({
    amount: "17.23",
    currency: "BRL",
  });
});

for (const status of [undefined, "PENDING", "PENDING_REFERENCE"]) {
  test(`WIN waits without terminal metadata for ${status ?? "missing"} BET reference`, () => {
    const transaction = WagerTransaction.create(
      props({ referenceExternalTransactionId: "later-bet" }),
    );
    const bet =
      status === undefined ? undefined : reference(transaction, { status });
    transaction.resolveReference(bet, at);
    expect(transaction.status).toBe("PENDING_REFERENCE");
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
    expect(transaction.referenceTransactionId).toBe(bet?.id);
    transaction.resolveReference(reference(transaction), at);
    transaction.markProcessed(at);
    expect(transaction.status).toBe("PROCESSED");
  });
}

for (const field of [
  "providerId",
  "externalTransactionId",
  "walletId",
  "playerId",
  "currency",
  "roundId",
  "kind",
] as const) {
  test(`WIN rejects mismatched reference ${field}`, () => {
    const transaction = WagerTransaction.create(
      props({ referenceExternalTransactionId: "bet-external" }),
    );
    const bet = reference(transaction, {
      [field]: field === "kind" ? "WIN" : "different",
    });
    transaction.resolveReference(bet, at);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_MISMATCH");
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.referenceTransactionId).toBe(bet.id);
  });
}

for (const status of ["REJECTED", "FAILED"]) {
  test(`WIN rejects terminal ${status} BET reference`, () => {
    const transaction = WagerTransaction.create(
      props({ referenceExternalTransactionId: "bet-external" }),
    );
    const bet = reference(transaction, { status });
    transaction.resolveReference(bet, at);
    expect(transaction.status).toBe("REJECTED");
    expect(transaction.failureCode).toBe("REFERENCE_NOT_PROCESSED");
    expect(transaction.referenceTransactionId).toBe(bet.id);
  });
}

for (const terminal of ["PROCESSED", "REJECTED"] as const) {
  test(`terminal ${terminal} WIN cannot change state or bind another reference`, () => {
    const transaction = WagerTransaction.create(
      props(
        terminal === "REJECTED"
          ? { referenceExternalTransactionId: "bet-external" }
          : {},
      ),
    );
    if (terminal === "PROCESSED") transaction.markProcessed(at);
    else transaction.reject("REFERENCE_MISMATCH", at);
    const failureCode = transaction.failureCode;
    for (const transition of [
      () => transaction.markProcessed(at),
      () => transaction.markPendingReference(),
      () => transaction.reject("REFERENCE_NOT_PROCESSED", at),
      () => transaction.resolveReference(undefined, at),
    ]) {
      expect(transition).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
      expect(transaction.status).toBe(terminal);
      expect(transaction.failureCode).toBe(failureCode);
      expect(transaction.processedAt).toEqual(at);
    }
  });
}

for (const value of [
  null,
  "",
  " ",
  " leading",
  "trailing ",
  "a".repeat(201),
  "a\u0000b",
  123,
  [],
]) {
  test(`WIN rejects malformed reference ${JSON.stringify(value)}`, () => {
    expect(() =>
      WagerTransaction.create({
        ...props(),
        referenceExternalTransactionId: value,
      } as never),
    ).toThrow(new DomainError("INVALID_IDENTITY"));
  });
}

test("BET keeps rejecting WIN-only reference input", () => {
  expect(() =>
    WagerTransaction.create(
      props({ kind: "BET", referenceExternalTransactionId: "bet-external" }),
    ),
  ).toThrow(new DomainError("INVALID_TRANSACTION_PAYLOAD"));
});

test("LOSS processes once and rejects every transition from its terminal state", () => {
  const transaction = WagerTransaction.create(props({ kind: "LOSS" }));
  transaction.markProcessed(at);
  expect(transaction.status).toBe("PROCESSED");
  expect(transaction.processedAt).toEqual(at);
  expect(transaction.failureCode).toBeUndefined();
  for (const transition of [
    () => transaction.markProcessed(at),
    () => transaction.markPendingReference(),
    () => transaction.reject("INSUFFICIENT_FUNDS", at),
    () => transaction.resolveReference(undefined, at),
  ]) {
    expect(transition).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
    expect(transaction.status).toBe("PROCESSED");
    expect(transaction.processedAt).toEqual(at);
  }
});
