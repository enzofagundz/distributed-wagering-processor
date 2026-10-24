import { expect, test } from "bun:test";
import { DomainError, Money } from "../../src/domain/money";
import {
  type CreateWagerTransactionProps,
  type ExternalWagerKind,
  externalWagerKinds,
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

function hashed(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    providerId: "provider-hash",
    externalTransactionId: "bet-hash-1",
    idempotencyKey: "provider-hash:bet-hash-1",
    walletId: "11111111-1111-4111-8111-111111111111",
    playerId: "22222222-2222-4222-8222-222222222222",
    roundId: "round-hash",
    gameId: "fortune-chimp",
    kind: "BET",
    money: Money.from({ amount: "25.00", currency: "BRL" }),
    ...overrides,
  };
}

const referenceRequired: Readonly<Record<ExternalWagerKind, boolean>> = {
  BET: false,
  WIN: false,
  LOSS: false,
  REFUND: true,
  ROLLBACK: true,
};

function kindProps(
  kind: ExternalWagerKind,
): Partial<CreateWagerTransactionProps> {
  const externalTransactionId = `${kind.toLowerCase()}-hash`;
  return {
    kind,
    externalTransactionId,
    idempotencyKey: `provider-hash:${externalTransactionId}`,
    ...(referenceRequired[kind]
      ? { referenceExternalTransactionId: "bet-hash-1" }
      : {}),
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
    payloadHash: "a".repeat(64),
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

const payloadHashCases: readonly {
  name: string;
  overrides: Partial<CreateWagerTransactionProps>;
  payloadHash: string;
}[] = [
  {
    name: "BET",
    overrides: {},
    payloadHash:
      "f7b64edfec8960f47c13572dfbddf5280d6209a99f80ace38b260a2c78114ed6",
  },
  {
    name: "WIN with reference",
    overrides: {
      externalTransactionId: "win-hash-1",
      idempotencyKey: "provider-hash:win-hash-1",
      kind: "WIN",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: "bet-hash-1",
    },
    payloadHash:
      "26d6f836f069365596357e15be69cabd62595376d6c77ec8cdf27ff76556714c",
  },
  {
    name: "REFUND",
    overrides: {
      externalTransactionId: "refund-hash-1",
      idempotencyKey: "provider-hash:refund-hash-1",
      kind: "REFUND",
      referenceExternalTransactionId: "bet-hash-1",
    },
    payloadHash:
      "ca2a138e95a1902f6016c611b2817c696bc3e8b55f2927c468ac2b10ca39bcbd",
  },
  {
    name: "ROLLBACK",
    overrides: {
      externalTransactionId: "rollback-hash-1",
      idempotencyKey: "provider-hash:rollback-hash-1",
      kind: "ROLLBACK",
      referenceExternalTransactionId: "bet-hash-1",
    },
    payloadHash:
      "984f178f06df3e4e472220e0e80052119df11c62319ce42b887d8e418dd636b7",
  },
  {
    name: "LOSS",
    overrides: {
      externalTransactionId: "loss-hash-1",
      idempotencyKey: "provider-hash:loss-hash-1",
      kind: "LOSS",
      money: Money.from({ amount: "5.00", currency: "BRL" }),
    },
    payloadHash:
      "efb6eb5199dd95d4f3798f74548fc1c45d0133f3bf30db0dc59c1264070beb95",
  },
  {
    name: "BET with a 28-digit amount",
    overrides: {
      externalTransactionId: "bet-hash-28",
      idempotencyKey: "provider-hash:bet-hash-28",
      walletId: "33333333-3333-4333-8333-333333333333",
      playerId: "44444444-4444-4444-8444-444444444444",
      money: Money.from({
        amount: "1234567890123456789012345678.00",
        currency: "BRL",
      }),
    },
    payloadHash:
      "a3371e2296d8c816cb5772534f76ec3b9c4ee041fc3f329c51515881399df918",
  },
  {
    name: "BET with quotes, backslash and accented round",
    overrides: {
      externalTransactionId: 'bet-esp"1',
      idempotencyKey: 'provider-hash:bet-esp"1',
      gameId: 'quote"slash\\tab',
      roundId: "round-ção",
      walletId: "22222222-2222-4222-8222-222222222222",
      playerId: "11111111-1111-4111-8111-111111111111",
      money: Money.from({ amount: "7.50", currency: "BRL" }),
    },
    payloadHash:
      "54b7702853f2404ffb4e4066b445402777387e990b5d8e09f9260b783f77e1a0",
  },
  {
    name: "BET with composed unicode",
    overrides: {
      externalTransactionId: "bet-unicode",
      idempotencyKey: "provider-hash:bet-unicode",
      gameId: "café",
      walletId: "22222222-2222-4222-8222-222222222222",
      playerId: "11111111-1111-4111-8111-111111111111",
      money: Money.from({ amount: "7.50", currency: "BRL" }),
    },
    payloadHash:
      "fb28fbc34bfb12c9267913f44628a01f6319f9446151c0c9b16b32ea4827f981",
  },
  {
    name: "BET with decomposed unicode",
    overrides: {
      externalTransactionId: "bet-unicode",
      idempotencyKey: "provider-hash:bet-unicode",
      gameId: "cafe\u0301",
      walletId: "22222222-2222-4222-8222-222222222222",
      playerId: "11111111-1111-4111-8111-111111111111",
      money: Money.from({ amount: "7.50", currency: "BRL" }),
    },
    payloadHash:
      "8e9c58f65d687d2e23196a95e37b62567f306a79c8fc4ee328dd2af0565bc331",
  },
];

for (const { name, overrides, payloadHash } of payloadHashCases) {
  test(`payload hash keeps the pre-refactor bytes for ${name}`, () => {
    const transaction = WagerTransaction.create(hashed(overrides));
    expect(transaction.payloadHash).toBe(payloadHash);
    expect(transaction.matchesPayload(payloadHash)).toBe(true);
    expect(transaction.matchesPayload("0".repeat(64))).toBe(false);
  });
}

test("payload hash uses UUIDs after normalization", () => {
  const walletId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const playerId = "ffffffff-0000-4000-8000-111111111111";
  const lower = WagerTransaction.create(hashed({ walletId, playerId }));
  const upper = WagerTransaction.create(
    hashed({
      walletId: walletId.toUpperCase(),
      playerId: playerId.toUpperCase(),
    }),
  );
  expect(upper.payloadHash).toBe(lower.payloadHash);
});

test("rehydrate keeps the persisted hash instead of recomputing it", () => {
  const created = WagerTransaction.create(hashed());
  const persisted = "b".repeat(64);
  const transaction = WagerTransaction.rehydrate({
    ...hashed(),
    payloadHash: persisted,
    status: "PROCESSED",
    createdAt: at,
    processedAt: at,
  });
  expect(transaction.payloadHash).toBe(persisted);
  expect(transaction.matchesPayload(persisted)).toBe(true);
  expect(transaction.matchesPayload(created.payloadHash)).toBe(false);
});

for (const kind of externalWagerKinds) {
  test(`${kind} answers the state queries from its kind`, () => {
    const transaction = WagerTransaction.create(hashed(kindProps(kind)));
    expect(transaction.affectsBalance()).toBe(kind !== "LOSS");
    expect(transaction.requiresReference()).toBe(referenceRequired[kind]);
    expect(transaction.isTerminal()).toBe(false);
  });

  for (const terminal of ["PROCESSED", "REJECTED", "FAILED"] as const) {
    test(`${kind} ${terminal} is terminal`, () => {
      const transaction = WagerTransaction.rehydrate({
        ...hashed(kindProps(kind)),
        payloadHash: "a".repeat(64),
        status: terminal,
        createdAt: at,
        processedAt: at,
      });
      expect(transaction.isTerminal()).toBe(true);
      expect(transaction.affectsBalance()).toBe(kind !== "LOSS");
      expect(transaction.requiresReference()).toBe(referenceRequired[kind]);
    });
  }
}

test("PENDING_REFERENCE is not terminal", () => {
  for (const kind of ["WIN", "REFUND", "ROLLBACK"] as const) {
    const transaction = WagerTransaction.create(
      hashed({
        ...kindProps(kind),
        ...(kind === "WIN"
          ? { referenceExternalTransactionId: "bet-hash-1" }
          : {}),
      }),
    );
    transaction.resolveReference(undefined, at);
    expect(transaction.status).toBe("PENDING_REFERENCE");
    expect(transaction.isTerminal()).toBe(false);
  }
});
