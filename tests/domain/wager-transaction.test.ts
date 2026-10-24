import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  type WagerReference,
  WagerTransaction,
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

test("only a pending reference can expire and its rejection cannot reopen", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "never-arrives" }),
  );
  expect(() => transaction.reject("REFERENCE_NOT_FOUND", at)).toThrow(
    new DomainError("INVALID_TRANSACTION_STATE"),
  );
  transaction.resolveReference(undefined, at);
  transaction.reject("REFERENCE_NOT_FOUND", at);
  expect(transaction.status).toBe("REJECTED");
  expect(transaction.failureCode).toBe("REFERENCE_NOT_FOUND");
  expect(transaction.referenceTransactionId).toBeUndefined();
  expect(transaction.processedAt).toEqual(at);
  expect(() =>
    transaction.resolveReference(reference(transaction), at),
  ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
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

test("fail from PENDING marks a referenced WIN FAILED with the infrastructure code", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "bet-external" }),
  );
  transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE", at);
  expect(transaction.status).toBe("FAILED");
  expect(transaction.failureCode).toBe("PERMANENT_INFRASTRUCTURE_FAILURE");
  expect(transaction.processedAt).toEqual(at);
  expect(transaction.referenceExternalTransactionId).toBe("bet-external");
  expect(transaction.referenceTransactionId).toBeUndefined();
});

test("fail from PENDING_REFERENCE keeps the binding and records audit metadata", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "later-bet" }),
  );
  transaction.resolveReference(undefined, at);
  expect(transaction.status).toBe("PENDING_REFERENCE");
  const failedAt = new Date(at.getTime() + 1000);
  transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE", failedAt);
  expect(transaction.status).toBe("FAILED");
  expect(transaction.failureCode).toBe("PERMANENT_INFRASTRUCTURE_FAILURE");
  expect(transaction.processedAt).toEqual(failedAt);
  expect(transaction.referenceExternalTransactionId).toBe("later-bet");
});

for (const terminal of ["PROCESSED", "REJECTED", "FAILED"] as const) {
  test(`terminal ${terminal} refuses fail and keeps its audit metadata`, () => {
    const transaction = WagerTransaction.create(
      props(
        terminal === "PROCESSED"
          ? {}
          : { referenceExternalTransactionId: "bet-external" },
      ),
    );
    if (terminal === "PROCESSED") transaction.markProcessed(at);
    else if (terminal === "REJECTED")
      transaction.reject("REFERENCE_MISMATCH", at);
    else transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE", at);
    const failureCode = transaction.failureCode;
    expect(() =>
      transaction.fail(
        "PERMANENT_INFRASTRUCTURE_FAILURE",
        new Date(at.getTime() + 1000),
      ),
    ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
    expect(transaction.status).toBe(terminal);
    expect(transaction.failureCode).toBe(failureCode);
    expect(transaction.processedAt).toEqual(at);
  });
}

test("fail rejects BET, LOSS, WIN without reference and invalid instants", () => {
  for (const kind of ["BET", "LOSS"] as const) {
    const transaction = WagerTransaction.create(props({ kind }));
    expect(() =>
      transaction.fail("PERMANENT_INFRASTRUCTURE_FAILURE", at),
    ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
    expect(transaction.status).toBe("PENDING");
  }
  const independentWin = WagerTransaction.create(props());
  expect(() =>
    independentWin.fail("PERMANENT_INFRASTRUCTURE_FAILURE", at),
  ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
  const referenced = WagerTransaction.create(
    props({ referenceExternalTransactionId: "bet-external" }),
  );
  expect(() =>
    referenced.fail("PERMANENT_INFRASTRUCTURE_FAILURE", new Date(Number.NaN)),
  ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
  expect(referenced.status).toBe("PENDING");
});

test("reject refuses the infrastructure code while accepting commercial codes", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "bet-external" }),
  );
  expect(() =>
    transaction.reject("PERMANENT_INFRASTRUCTURE_FAILURE" as never, at),
  ).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
  expect(transaction.status).toBe("PENDING");
  expect(transaction.failureCode).toBeUndefined();
  transaction.reject("REFERENCE_NOT_PROCESSED", at);
  expect(transaction.status).toBe("REJECTED");
  expect(transaction.failureCode).toBe("REFERENCE_NOT_PROCESSED");
});

test("rehydrated FAILED refuses every transition without replaying fail", () => {
  const transaction = WagerTransaction.rehydrate({
    ...props({ referenceExternalTransactionId: "bet-external" }),
    status: "FAILED",
    failureCode: "PERMANENT_INFRASTRUCTURE_FAILURE",
    processedAt: at,
    createdAt: at,
  });
  expect(transaction.status).toBe("FAILED");
  expect(transaction.failureCode).toBe("PERMANENT_INFRASTRUCTURE_FAILURE");
  expect(transaction.processedAt).toEqual(at);
  for (const transition of [
    () =>
      transaction.fail(
        "PERMANENT_INFRASTRUCTURE_FAILURE",
        new Date(at.getTime() + 1000),
      ),
    () => transaction.reject("REFERENCE_NOT_PROCESSED", at),
    () => transaction.markProcessed(at),
    () => transaction.markPendingReference(),
    () => transaction.resolveReference(undefined, at),
  ]) {
    expect(transition).toThrow(new DomainError("INVALID_TRANSACTION_STATE"));
    expect(transaction.status).toBe("FAILED");
    expect(transaction.processedAt).toEqual(at);
  }
});

test("fail refuses commercial codes without leaving PENDING", () => {
  const transaction = WagerTransaction.create(
    props({ referenceExternalTransactionId: "bet-external" }),
  );
  for (const code of [
    "INSUFFICIENT_FUNDS",
    "REFERENCE_NOT_PROCESSED",
    "REFERENCE_NOT_FOUND",
  ])
    expect(() => transaction.fail(code as never, at)).toThrow(
      new DomainError("INVALID_TRANSACTION_STATE"),
    );
  expect(transaction.status).toBe("PENDING");
  expect(transaction.failureCode).toBeUndefined();
  expect(transaction.processedAt).toBeUndefined();
});
