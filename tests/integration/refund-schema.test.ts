import { afterAll, beforeAll, expect, test } from "bun:test";
import { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { databaseConfig } from "../../src/persistence/config";

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point to a dedicated database ending in _test",
  );
let orm: MikroORM;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.migrator.up();
});
afterAll(async () => {
  await orm?.close();
});

type Fixture = {
  walletId: string;
  playerId: string;
  betId: string;
  externalBetId: string;
};
type Values = {
  kind: string;
  status: string;
  referenceExternalId: string | null;
  referenceId: string | null;
  failureCode: string | null;
  processedAt: Date | null;
  payloadHash: string | null;
  observedBalance: string | null;
};

async function withFixture(
  run: (em: EntityManager, fixture: Fixture) => Promise<void>,
  database = orm,
) {
  const rollback = new Error("Rollback refund schema fixture");
  try {
    await database.em.transactional(async (em) => {
      const fixture = {
        walletId: crypto.randomUUID(),
        playerId: crypto.randomUUID(),
        betId: crypto.randomUUID(),
        externalBetId: crypto.randomUUID(),
      };
      await em.execute(
        "insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, 75.00, 1, now(), now())",
        [fixture.walletId, fixture.playerId, "BRL"],
      );
      await em.execute(
        `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
        provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id, observed_balance, processed_at, created_at)
        values (?, ?, ?, 'BRL', 25.00, 'BET', 'PROCESSED', 'provider-refund-schema', ?, ?, ?, 'round-refund', 'game-refund', 75.00, now(), now())`,
        [
          fixture.betId,
          fixture.walletId,
          fixture.playerId,
          fixture.externalBetId,
          crypto.randomUUID(),
          "a".repeat(64),
        ],
      );
      await run(em, fixture);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function insertTransaction(
  em: EntityManager,
  fixture: Fixture,
  overrides: Partial<Values> = {},
) {
  const values: Values = {
    kind: "REFUND",
    status: "PROCESSED",
    referenceExternalId: fixture.externalBetId,
    referenceId: fixture.betId,
    failureCode: null,
    processedAt: new Date(),
    payloadHash: "b".repeat(64),
    observedBalance: "100.00",
    ...overrides,
  };
  const id = crypto.randomUUID();
  await em.execute(
    `insert into wager_transactions (id, wallet_id, player_id, currency, amount, kind, status,
    provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id,
    reference_external_transaction_id, reference_transaction_id, failure_code, processed_at, observed_balance, created_at)
    values (?, ?, ?, 'BRL', 25.00, ?, ?, 'provider-refund-schema', ?, ?, ?, 'round-refund', 'game-refund', ?, ?, ?, ?, ?, now())`,
    [
      id,
      fixture.walletId,
      fixture.playerId,
      values.kind,
      values.status,
      crypto.randomUUID(),
      crypto.randomUUID(),
      values.payloadHash,
      values.referenceExternalId,
      values.referenceId,
      values.failureCode,
      values.processedAt,
      values.observedBalance,
    ],
  );
  return id;
}

async function expectSqlState(
  em: EntityManager,
  code: string,
  run: (nested: EntityManager) => Promise<unknown>,
) {
  await expect(em.transactional(run)).rejects.toMatchObject({ code });
}

async function withIsolatedSchema(run: (database: MikroORM) => Promise<void>) {
  const schema = `refund_schema_${crypto.randomUUID().replaceAll("-", "")}`;
  await orm.em.execute(`create schema ${schema}`);
  let database: MikroORM | undefined;
  try {
    database = await MikroORM.init({
      ...databaseConfig(url),
      schema,
      driverOptions: { connection: { options: `-c search_path=${schema}` } },
    });
    await database.migrator.up();
    await run(database);
  } finally {
    await database?.close();
    await orm.em.execute(`drop schema ${schema} cascade`);
  }
}

test("PostgreSQL permits one processed REFUND per reference and retains rejected duplicate audit", async () => {
  await withFixture(async (em, fixture) => {
    const firstId = await insertTransaction(em, fixture);
    await expect(
      em.transactional((nested) => insertTransaction(nested, fixture)),
    ).rejects.toMatchObject({
      code: "23505",
      constraint: "wager_transactions_refund_reference_unique",
    });
    const rejectedId = await insertTransaction(em, fixture, {
      status: "REJECTED",
      failureCode: "REFERENCE_ALREADY_REFUNDED",
      observedBalance: "100.00",
    });
    expect(
      await em.execute(
        "select id, status, failure_code from wager_transactions where id in (?, ?) order by status",
        [firstId, rejectedId],
      ),
    ).toEqual([
      { id: firstId, status: "PROCESSED", failure_code: null },
      {
        id: rejectedId,
        status: "REJECTED",
        failure_code: "REFERENCE_ALREADY_REFUNDED",
      },
    ]);
    const otherBetId = await insertTransaction(em, fixture, {
      kind: "BET",
      referenceExternalId: null,
      referenceId: null,
    });
    const [otherBet] = await em.execute<{ external_transaction_id: string }[]>(
      "select external_transaction_id from wager_transactions where id = ?",
      [otherBetId],
    );
    await insertTransaction(em, fixture, {
      referenceId: otherBetId,
      referenceExternalId: otherBet!.external_transaction_id,
    });
  });
});

test("rejected and pending REFUND attempts do not reserve successful refund reference", async () => {
  await withFixture(async (em, fixture) => {
    for (const failureCode of [
      "REFERENCE_MISMATCH",
      "REFERENCE_NOT_PROCESSED",
      "REFERENCE_ALREADY_REFUNDED",
    ]) {
      await insertTransaction(em, fixture, {
        status: "REJECTED",
        failureCode,
        observedBalance: "75.00",
      });
    }
    await insertTransaction(em, fixture, {
      status: "PENDING_REFERENCE",
      referenceId: null,
      processedAt: null,
      observedBalance: "75.00",
    });
    await insertTransaction(em, fixture, {
      status: "PENDING_REFERENCE",
      processedAt: null,
      observedBalance: "75.00",
    });
    await insertTransaction(em, fixture);
    expect(
      await em.execute(
        `select status, count(*)::int as count from wager_transactions
      where kind = 'REFUND' and wallet_id = ? group by status order by status`,
        [fixture.walletId],
      ),
    ).toEqual([
      { status: "PENDING_REFERENCE", count: 2 },
      { status: "PROCESSED", count: 1 },
      { status: "REJECTED", count: 3 },
    ]);
  });
});

test("REFUND requires wellformed external reference and resolved id for terminal states", async () => {
  await withFixture(async (em, fixture) => {
    for (const referenceExternalId of [
      null,
      "",
      " leading",
      "trailing ",
      "tab\tinside",
      "line\nbreak",
      "x".repeat(201),
    ]) {
      await expectSqlState(
        em,
        referenceExternalId?.length === 201 ? "22001" : "23514",
        (nested) =>
          insertTransaction(nested, fixture, {
            referenceExternalId,
            referenceId: null,
            status: "PENDING_REFERENCE",
            processedAt: null,
          }),
      );
    }
    for (const overrides of [
      { referenceId: null },
      {
        referenceId: null,
        status: "REJECTED",
        failureCode: "REFERENCE_NOT_PROCESSED",
      },
    ]) {
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, overrides),
      );
    }
    await expectSqlState(em, "23503", (nested) =>
      insertTransaction(nested, fixture, { referenceId: crypto.randomUUID() }),
    );
    await expectSqlState(em, "23503", (nested) =>
      insertTransaction(nested, fixture, {
        referenceExternalId: "different-reference",
      }),
    );
  });
});

test("REFUND enforces pending and terminal audit shapes and failure taxonomy", async () => {
  await withFixture(async (em, fixture) => {
    const invalid: Partial<Values>[] = [
      { payloadHash: null },
      { payloadHash: "bad-hash" },
      { observedBalance: null },
      { observedBalance: "-0.01" },
      { failureCode: "REFERENCE_MISMATCH" },
      { processedAt: null },
      { status: "REJECTED", failureCode: null },
      { status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS" },
      {
        status: "REJECTED",
        failureCode: "REFERENCE_MISMATCH",
        processedAt: null,
      },
      { status: "PENDING_REFERENCE", referenceId: null },
      {
        status: "PENDING_REFERENCE",
        referenceId: null,
        processedAt: null,
        failureCode: "REFERENCE_NOT_PROCESSED",
      },
    ];
    for (const values of invalid)
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, values),
      );
  });
});

test("REFUND schema preserves BET WIN LOSS reference and rejection contracts", async () => {
  await withFixture(async (em, fixture) => {
    for (const kind of ["BET", "LOSS"]) {
      await insertTransaction(em, fixture, {
        kind,
        referenceExternalId: null,
        referenceId: null,
      });
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture, { kind }),
      );
    }
    await insertTransaction(em, fixture, {
      kind: "BET",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      referenceExternalId: null,
      referenceId: null,
    });
    await expectSqlState(em, "23514", (nested) =>
      insertTransaction(nested, fixture, {
        kind: "LOSS",
        status: "REJECTED",
        failureCode: "REFERENCE_MISMATCH",
        referenceExternalId: null,
        referenceId: null,
      }),
    );
    await insertTransaction(em, fixture, {
      kind: "WIN",
      referenceExternalId: null,
      referenceId: null,
    });
    await insertTransaction(em, fixture, { kind: "WIN" });
    for (const failureCode of [
      "REFERENCE_MISMATCH",
      "REFERENCE_NOT_PROCESSED",
    ]) {
      await insertTransaction(em, fixture, {
        kind: "WIN",
        status: "REJECTED",
        failureCode,
      });
    }
    await insertTransaction(em, fixture, {
      kind: "WIN",
      status: "PENDING_REFERENCE",
      referenceId: null,
      processedAt: null,
    });
    await expectSqlState(em, "23514", (nested) =>
      insertTransaction(nested, fixture, {
        kind: "WIN",
        status: "REJECTED",
        failureCode: "REFERENCE_ALREADY_REFUNDED",
      }),
    );
  });
});

test("REFUND migration down restores LOSS schema and up reapplies successful refund uniqueness", async () => {
  await withIsolatedSchema(async (database) => {
    await database.migrator.down();
    await withFixture(async (em, fixture) => {
      await insertTransaction(em, fixture, {
        kind: "LOSS",
        referenceExternalId: null,
        referenceId: null,
      });
      await insertTransaction(em, fixture, {
        kind: "WIN",
        referenceExternalId: null,
        referenceId: null,
      });
      await expectSqlState(em, "23514", (nested) =>
        insertTransaction(nested, fixture),
      );
    }, database);
    await database.migrator.up();
    await withFixture(async (em, fixture) => {
      await insertTransaction(em, fixture);
      await expectSqlState(em, "23505", (nested) =>
        insertTransaction(nested, fixture),
      );
    }, database);
  });
});

test("REFUND migration refuses down for processed rejected and pending history without erasing audit", async () => {
  for (const status of ["PROCESSED", "REJECTED", "PENDING_REFERENCE"]) {
    await withIsolatedSchema(async (database) => {
      await withFixture(async (em, fixture) => {
        const id = await insertTransaction(em, fixture, {
          status,
          failureCode: status === "REJECTED" ? "REFERENCE_MISMATCH" : null,
          referenceId: status === "PENDING_REFERENCE" ? null : fixture.betId,
          processedAt: status === "PENDING_REFERENCE" ? null : new Date(),
        });
        const before = await em.execute(
          "select * from wager_transactions where id = ?",
          [id],
        );
        await expect(
          em.transactional((nested) =>
            database.migrator.down({
              transaction: nested.getTransactionContext(),
            }),
          ),
        ).rejects.toThrow(
          "Cannot remove REFUND schema while REFUND history exists",
        );
        expect(
          await em.execute("select * from wager_transactions where id = ?", [
            id,
          ]),
        ).toEqual(before);
      }, database);
    });
  }
});
